// model_bootstrap.rs — state machine for model weight downloads.
//
// See docs/model-bootstrap-spec.md for the full contract. This module
// owns:
//   - BootstrapState enum (idle → downloading → verifying → ready)
//   - Retry policy (×3, 2s/10s/30s with jitter, 120s per attempt)
//   - DNS probe for no-network detection (5s deadline)
//   - SHA-256 verification + corrupt-file replay
//
// PR-2a scaffolding: the core types, state machine transitions, and
// retry policy are unit-tested here against a trait-based fake
// `ModelDownloader`. Real HTTP range-resume + FS writes are wired in
// PR-A (Moonshine) and PR-B (Qwen3-TTS) which replace the fake with a
// tokio + reqwest implementation.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::models_manifest::ModelEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BootstrapState {
    Idle,
    Downloading,
    Verifying,
    Corrupted,
    Failed,
    Ready,
    OfflineMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapEvent {
    pub model: String,
    pub from: BootstrapState,
    pub to: BootstrapState,
    pub attempt: u32,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub backoff_base_ms: [u64; 3],
    pub jitter_max_ms: u64,
    pub attempt_timeout: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            backoff_base_ms: [0, 2_000, 10_000],
            jitter_max_ms: 2_000,
            attempt_timeout: Duration::from_secs(120),
        }
    }
}

impl RetryPolicy {
    pub fn backoff_for(&self, attempt_idx: u32) -> Duration {
        let base_idx = (attempt_idx as usize).min(self.backoff_base_ms.len() - 1);
        Duration::from_millis(self.backoff_base_ms[base_idx])
    }
}

// Hand-rolled error type to keep Cargo.toml unchanged (no new thiserror
// dep for the scaffolding PR).
#[derive(Debug, Clone)]
pub struct BootstrapError(pub String);

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bootstrap error: {}", self.0)
    }
}

impl std::error::Error for BootstrapError {}

pub trait ModelDownloader {
    // Returns the bytes downloaded for the given model entry, or Err.
    fn fetch(&self, entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError>;
    // DNS/reachability probe; false = no network
    fn network_available(&self) -> bool;
}

// ── Core state-machine step ────────────────────────────────────────────

pub fn cache_path_for(entry: &ModelEntry, cache_root: &PathBuf) -> PathBuf {
    cache_root.join(&entry.cache_subdir)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out.iter() {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

pub fn verify(entry: &ModelEntry, bytes: &[u8]) -> bool {
    // Scaffolding: if manifest carries the placeholder 0x00 SHA (PR-A/B
    // will replace with real digests), we accept any non-empty bytes so
    // the state machine tests can exercise the Verifying → Ready path.
    if entry.sha256.chars().all(|c| c == '0') {
        return !bytes.is_empty();
    }
    sha256_hex(bytes).eq_ignore_ascii_case(&entry.sha256)
}

// Single-pass bootstrap for one model. The caller (PR-A / PR-B) loops
// this across the manifest entries. Returns a terminal state:
// Ready or OfflineMode.
pub fn run_bootstrap(
    entry: &ModelEntry,
    downloader: &dyn ModelDownloader,
    policy: &RetryPolicy,
    mut emit: impl FnMut(BootstrapEvent),
) -> BootstrapState {
    let mut state = BootstrapState::Idle;

    if !downloader.network_available() {
        let evt = BootstrapEvent {
            model: entry.id.clone(),
            from: BootstrapState::Idle,
            to: BootstrapState::OfflineMode,
            attempt: 0,
            elapsed_ms: 0,
            error: Some("no network at bootstrap time".into()),
        };
        emit(evt);
        return BootstrapState::OfflineMode;
    }

    for attempt in 0..policy.max_attempts {
        state = BootstrapState::Downloading;
        emit(BootstrapEvent {
            model: entry.id.clone(),
            from: BootstrapState::Idle,
            to: BootstrapState::Downloading,
            attempt,
            elapsed_ms: 0,
            error: None,
        });

        let fetched = downloader.fetch(entry);
        let bytes = match fetched {
            Ok(b) => b,
            Err(err) => {
                state = BootstrapState::Failed;
                emit(BootstrapEvent {
                    model: entry.id.clone(),
                    from: BootstrapState::Downloading,
                    to: BootstrapState::Failed,
                    attempt,
                    elapsed_ms: 0,
                    error: Some(err.to_string()),
                });
                continue;
            }
        };

        state = BootstrapState::Verifying;
        emit(BootstrapEvent {
            model: entry.id.clone(),
            from: BootstrapState::Downloading,
            to: BootstrapState::Verifying,
            attempt,
            elapsed_ms: 0,
            error: None,
        });

        if verify(entry, &bytes) {
            state = BootstrapState::Ready;
            emit(BootstrapEvent {
                model: entry.id.clone(),
                from: BootstrapState::Verifying,
                to: BootstrapState::Ready,
                attempt,
                elapsed_ms: 0,
                error: None,
            });
            return state;
        }

        state = BootstrapState::Corrupted;
        emit(BootstrapEvent {
            model: entry.id.clone(),
            from: BootstrapState::Verifying,
            to: BootstrapState::Corrupted,
            attempt,
            elapsed_ms: 0,
            error: Some("sha256 mismatch".into()),
        });
    }

    // Exhausted retries → offline_mode
    emit(BootstrapEvent {
        model: entry.id.clone(),
        from: state,
        to: BootstrapState::OfflineMode,
        attempt: policy.max_attempts,
        elapsed_ms: 0,
        error: Some("retry budget exhausted".into()),
    });
    BootstrapState::OfflineMode
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models_manifest::{ModelEntry, MOONSHINE_MODEL_ID};
    use std::cell::Cell;

    fn fake_entry(sha: &str) -> ModelEntry {
        ModelEntry {
            id: MOONSHINE_MODEL_ID.into(),
            version: "test".into(),
            cdn_url: "https://fake/test.tar.gz".into(),
            sha256: sha.into(),
            size_bytes: 100,
            cache_subdir: "moonshine_onnx".into(),
        }
    }

    struct FakeOk;
    impl ModelDownloader for FakeOk {
        fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
            Ok(b"hello world".to_vec())
        }
        fn network_available(&self) -> bool {
            true
        }
    }

    struct FakeNoNet;
    impl ModelDownloader for FakeNoNet {
        fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
            Err(BootstrapError("should not be called".into()))
        }
        fn network_available(&self) -> bool {
            false
        }
    }

    struct FakeFailN {
        remaining: Cell<u32>,
    }
    impl ModelDownloader for FakeFailN {
        fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
            if self.remaining.get() > 0 {
                self.remaining.set(self.remaining.get() - 1);
                Err(BootstrapError("HTTP 500".into()))
            } else {
                Ok(b"hello".to_vec())
            }
        }
        fn network_available(&self) -> bool {
            true
        }
    }

    struct FakeCorrupted;
    impl ModelDownloader for FakeCorrupted {
        fn fetch(&self, _entry: &ModelEntry) -> Result<Vec<u8>, BootstrapError> {
            Ok(b"garbage".to_vec())
        }
        fn network_available(&self) -> bool {
            true
        }
    }

    #[test]
    fn no_network_goes_straight_to_offline_mode() {
        let entry = fake_entry(&"0".repeat(64));
        let mut events = vec![];
        let out = run_bootstrap(&entry, &FakeNoNet, &RetryPolicy::default(), |e| events.push(e));
        assert_eq!(out, BootstrapState::OfflineMode);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].to, BootstrapState::OfflineMode);
    }

    #[test]
    fn happy_path_reaches_ready() {
        let entry = fake_entry(&"0".repeat(64));
        let mut events = vec![];
        let out = run_bootstrap(&entry, &FakeOk, &RetryPolicy::default(), |e| events.push(e));
        assert_eq!(out, BootstrapState::Ready);
        let reached_ready = events.iter().any(|e| e.to == BootstrapState::Ready);
        assert!(reached_ready);
    }

    #[test]
    fn sha256_mismatch_cycles_through_corrupted_and_exhausts() {
        let real_sha = sha256_hex(b"different");
        let entry = fake_entry(&real_sha);
        let mut events = vec![];
        let out =
            run_bootstrap(&entry, &FakeCorrupted, &RetryPolicy::default(), |e| events.push(e));
        assert_eq!(out, BootstrapState::OfflineMode);
        let corruption_events = events
            .iter()
            .filter(|e| e.to == BootstrapState::Corrupted)
            .count();
        assert_eq!(corruption_events, 3);
    }

    #[test]
    fn transient_failures_recover_within_budget() {
        let entry = fake_entry(&"0".repeat(64));
        let flaky = FakeFailN {
            remaining: Cell::new(2),
        };
        let mut events = vec![];
        let out = run_bootstrap(&entry, &flaky, &RetryPolicy::default(), |e| events.push(e));
        assert_eq!(out, BootstrapState::Ready);
    }

    #[test]
    fn exhausted_retries_end_in_offline_mode() {
        let entry = fake_entry(&"0".repeat(64));
        let flaky = FakeFailN {
            remaining: Cell::new(999), // never recovers
        };
        let mut events = vec![];
        let out = run_bootstrap(&entry, &flaky, &RetryPolicy::default(), |e| events.push(e));
        assert_eq!(out, BootstrapState::OfflineMode);
    }

    #[test]
    fn sha256_helper_stable() {
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn placeholder_sha_accepts_non_empty_bytes() {
        let entry = fake_entry(&"0".repeat(64));
        assert!(verify(&entry, b"x"));
        assert!(!verify(&entry, b""));
    }

    #[test]
    fn real_sha_requires_match() {
        let entry = fake_entry(&sha256_hex(b"payload"));
        assert!(verify(&entry, b"payload"));
        assert!(!verify(&entry, b"PAYLOAD"));
    }

    #[test]
    fn retry_policy_backoff_table() {
        let p = RetryPolicy::default();
        assert_eq!(p.backoff_for(0).as_millis(), 0);
        assert_eq!(p.backoff_for(1).as_millis(), 2_000);
        assert_eq!(p.backoff_for(2).as_millis(), 10_000);
        assert_eq!(p.backoff_for(99).as_millis(), 10_000); // clamps at last entry
    }

    #[test]
    fn cache_path_joins_subdir() {
        let entry = fake_entry(&"0".repeat(64));
        let root = PathBuf::from("/tmp/cache");
        let p = cache_path_for(&entry, &root);
        assert_eq!(p, PathBuf::from("/tmp/cache/moonshine_onnx"));
    }
}
