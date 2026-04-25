// Integration test for model_bootstrap — exercises the public contract
// PR-A (Moonshine) and PR-B (Qwen3-TTS) will rely on.
//
// Scenarios mirror docs/model-bootstrap-spec.md §"State Transitions":
//   - no_network_enters_offline_mode
//   - sha256_mismatch_deletes_and_retries (3 corruption events, then offline)
//   - three_retries_then_offline (exhaustion on transient failures)
//   - transient_failures_recover_within_budget (flaky but eventually OK)

use pixel_terminal_lib::commands::model_bootstrap::{
    run_bootstrap, sha256_hex, verify, BootstrapError, BootstrapEvent, BootstrapState,
    ModelDownloader, RetryPolicy,
};
use pixel_terminal_lib::models_manifest::{ModelEntry, MOONSHINE_MODEL_ID};
use std::cell::Cell;

fn entry_with_sha(sha: &str) -> ModelEntry {
    ModelEntry {
        id: MOONSHINE_MODEL_ID.into(),
        version: "itest".into(),
        cdn_url: "https://fake/integration.tar.gz".into(),
        sha256: sha.into(),
        size_bytes: 42,
        cache_subdir: "moonshine_onnx".into(),
    }
}

// ── Fakes ──────────────────────────────────────────────────────────────

struct NoNetwork;
impl ModelDownloader for NoNetwork {
    fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
        panic!("fetch must not be called when network_available == false");
    }
    fn network_available(&self) -> bool {
        false
    }
}

struct AlwaysOk(Vec<u8>);
impl ModelDownloader for AlwaysOk {
    fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
        Ok(self.0.clone())
    }
    fn network_available(&self) -> bool {
        true
    }
}

struct CorruptedBytes;
impl ModelDownloader for CorruptedBytes {
    fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
        Ok(b"not-the-expected-payload".to_vec())
    }
    fn network_available(&self) -> bool {
        true
    }
}

struct FlakyN {
    fails_remaining: Cell<u32>,
    payload: Vec<u8>,
}
impl ModelDownloader for FlakyN {
    fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
        if self.fails_remaining.get() > 0 {
            self.fails_remaining.set(self.fails_remaining.get() - 1);
            Err(BootstrapError("transient HTTP 503".into()))
        } else {
            Ok(self.payload.clone())
        }
    }
    fn network_available(&self) -> bool {
        true
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[test]
fn no_network_enters_offline_mode() {
    let entry = entry_with_sha(&"0".repeat(64));
    let mut events: Vec<BootstrapEvent> = vec![];
    let out = run_bootstrap(&entry, &NoNetwork, &RetryPolicy::default(), |e| {
        events.push(e)
    });
    assert_eq!(out, BootstrapState::OfflineMode);
    // Offline transition must emit exactly one event — no spurious download
    // attempts when the DNS probe already said "no network."
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].to, BootstrapState::OfflineMode);
    assert!(events[0].error.is_some());
}

#[test]
fn sha256_mismatch_triggers_corruption_events_and_falls_offline() {
    // Pin SHA to the hash of a different payload so CorruptedBytes can
    // never satisfy it — the state machine must cycle through Corrupted
    // exactly `max_attempts` times before giving up.
    let expected_sha = sha256_hex(b"the-real-payload");
    let entry = entry_with_sha(&expected_sha);
    let mut events: Vec<BootstrapEvent> = vec![];
    let out = run_bootstrap(&entry, &CorruptedBytes, &RetryPolicy::default(), |e| {
        events.push(e)
    });
    assert_eq!(out, BootstrapState::OfflineMode);

    let corruption_events = events
        .iter()
        .filter(|e| e.to == BootstrapState::Corrupted)
        .count();
    assert_eq!(
        corruption_events,
        RetryPolicy::default().max_attempts as usize,
        "must emit one Corrupted event per retry attempt"
    );
    // Final event is the offline transition with a reason
    let last = events.last().expect("at least one event");
    assert_eq!(last.to, BootstrapState::OfflineMode);
    assert!(last.error.as_deref().unwrap_or("").contains("exhausted"));
}

#[test]
fn three_transient_failures_exhausts_budget() {
    let entry = entry_with_sha(&"0".repeat(64));
    let flaky = FlakyN {
        fails_remaining: Cell::new(999), // never recovers
        payload: b"doesnt-matter".to_vec(),
    };
    let mut events: Vec<BootstrapEvent> = vec![];
    let out = run_bootstrap(&entry, &flaky, &RetryPolicy::default(), |e| {
        events.push(e)
    });
    assert_eq!(out, BootstrapState::OfflineMode);

    let failure_events = events
        .iter()
        .filter(|e| e.to == BootstrapState::Failed)
        .count();
    assert_eq!(failure_events, RetryPolicy::default().max_attempts as usize);
}

#[test]
fn transient_failures_recover_within_budget() {
    // 2 transient failures, then success on attempt 3 → must still reach
    // Ready within the default 3-attempt budget.
    let entry = entry_with_sha(&"0".repeat(64));
    let flaky = FlakyN {
        fails_remaining: Cell::new(2),
        payload: b"good-bytes".to_vec(),
    };
    let mut events: Vec<BootstrapEvent> = vec![];
    let out = run_bootstrap(&entry, &flaky, &RetryPolicy::default(), |e| {
        events.push(e)
    });
    assert_eq!(out, BootstrapState::Ready);

    // Verify event ordering — at least two Failed events before the
    // terminal Ready.
    let ready_idx = events
        .iter()
        .position(|e| e.to == BootstrapState::Ready)
        .expect("Ready event expected");
    let failed_before_ready = events[..ready_idx]
        .iter()
        .filter(|e| e.to == BootstrapState::Failed)
        .count();
    assert_eq!(failed_before_ready, 2);
}

#[test]
fn verify_accepts_matching_sha_on_real_digest() {
    // Using a real SHA (not the 0-placeholder) still wires through the
    // integration surface correctly.
    let payload = b"integration-payload";
    let sha = sha256_hex(payload);
    let entry = entry_with_sha(&sha);
    assert!(verify(&entry, payload));
    assert!(!verify(&entry, b"integration-PAYLOAD"));
}

#[test]
fn happy_path_emits_downloading_verifying_ready_order() {
    let entry = entry_with_sha(&"0".repeat(64));
    let mut events: Vec<BootstrapEvent> = vec![];
    let _ = run_bootstrap(
        &entry,
        &AlwaysOk(b"fake-weights-bytes".to_vec()),
        &RetryPolicy::default(),
        |e| events.push(e),
    );

    // Sequence must contain Downloading → Verifying → Ready at least once
    // and in that order.
    let i_dl = events
        .iter()
        .position(|e| e.to == BootstrapState::Downloading)
        .expect("Downloading");
    let i_verify = events
        .iter()
        .position(|e| e.to == BootstrapState::Verifying)
        .expect("Verifying");
    let i_ready = events
        .iter()
        .position(|e| e.to == BootstrapState::Ready)
        .expect("Ready");
    assert!(i_dl < i_verify && i_verify < i_ready);
}
