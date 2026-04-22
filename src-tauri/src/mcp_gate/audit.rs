//! P2.F — permission-decision audit log.
//!
//! File: `~/.local/share/pixel-terminal/permission_audit.jsonl`
//! Shared across all Anima sessions. Each line is a self-contained
//! JSON object representing one allow/deny decision. Concurrent-safe
//! on macOS/Linux because we use `O_APPEND` and keep each line well
//! under `PIPE_BUF` (4096 bytes) — `display` is truncated to 200 chars.
//!
//! Each entry ties a decision to three pieces of evidence the plan
//! requires (Phase 2 acceptance #3):
//!   - `session_id`        — the ANIMA_SESSION the gate was launched with
//!   - `config_path_sha256` — SHA256 of the per-session `mcp.json` PATH
//!                             string, proving the gate was spawned from
//!                             a config at the mechanical template path
//!   - `pid`                — this gate process's pid (visible in `ps`)
//!
//! Rotation: not handled here (deferred to P7.C weekly rotation). The
//! file will grow append-only until then; design target is <10MB/week
//! at normal usage.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DISPLAY_MAX_CHARS: usize = 200;

#[derive(Debug, Clone)]
pub struct AuditCtx {
    pub session_id: String,
    pub config_path_sha256: String,
    pub pid: u32,
    pub audit_path: PathBuf,
}

impl AuditCtx {
    /// Build the default audit context for a gate subprocess:
    ///   - `session_id` from ANIMA_SESSION env var
    ///   - `config_path_sha256` = SHA256(string form of the per-session
    ///       `mcp.json` path at the mechanical template location)
    ///   - `pid` from `std::process::id()`
    ///   - `audit_path` at `~/.local/share/pixel-terminal/permission_audit.jsonl`
    pub fn from_env(ipc_dir: &Path) -> Self {
        let session_id = std::env::var("ANIMA_SESSION")
            .unwrap_or_else(|_| "default".to_string());
        let config_path = session_config_path(&session_id);
        let config_path_sha256 = sha256_hex(config_path.to_string_lossy().as_bytes());
        Self {
            session_id,
            config_path_sha256,
            pid: std::process::id(),
            audit_path: ipc_dir.join("permission_audit.jsonl"),
        }
    }
}

fn session_config_path(session_id: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    PathBuf::from(home)
        .join(".local/share/pixel-terminal/sessions")
        .join(session_id)
        .join("mcp.json")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

fn ts_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn truncate_display(s: &str) -> String {
    if s.chars().count() <= DISPLAY_MAX_CHARS { return s.to_string(); }
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= DISPLAY_MAX_CHARS { break; }
        out.push(c);
    }
    out.push('…');
    out
}

/// Append a decision entry. Best-effort: IO errors are surfaced to
/// stderr but MUST NOT propagate — the gate must still reply on the
/// protocol channel even if the audit log is unwritable (disk full,
/// permissions, etc). The calling code handles this by invoking
/// `append_decision` BEFORE sending the JSON-RPC reply but NEVER
/// treating its result as load-bearing.
pub fn append_decision(
    ctx: &AuditCtx,
    tool: &str,
    fingerprint: &str,
    display: &str,
    decision: &str, // "allow" | "deny"
    reason: &str,
) {
    let entry = json!({
        "ts_ms": ts_ms() as u64,
        "session_id": &ctx.session_id,
        "config_path_sha256": &ctx.config_path_sha256,
        "pid": ctx.pid,
        "tool": tool,
        "fingerprint": fingerprint,
        "display": truncate_display(display),
        "decision": decision,
        "reason": reason,
    });
    if let Err(e) = append_line(&ctx.audit_path, &entry) {
        eprintln!("mcp_gate: audit append failed: {}", e);
    }
}

fn append_line(path: &Path, entry: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let mut line = serde_json::to_string(entry)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    line.push('\n');
    // O_APPEND on macOS/Linux ensures the write is serialized against
    // concurrent writers; keeping the line <4096 bytes keeps each
    // write atomic vs partial interleaving.
    let mut f = OpenOptions::new().create(true).append(true).mode(0o600).open(path)?;
    f.write_all(line.as_bytes())?;
    f.flush()
}

/// Test helper: read every JSONL entry from the audit file.
#[cfg(test)]
pub fn read_all(path: &Path) -> Vec<Value> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new(); };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use std::sync::atomic::{AtomicU64, Ordering};
    // Monotonic counter — guarantees parallel-safe tempdir uniqueness even
    // when two threads observe the same nanos (clock granularity race).
    static TEMPDIR_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            let pid = std::process::id();
            let nonce: u128 = SystemTime::now()
                .duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let seq = TEMPDIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let p = base.join(format!("animaaudit-test-{}-{}-{}", pid, nonce, seq));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn ctx_in(dir: &Path) -> AuditCtx {
        AuditCtx {
            session_id: "sid-abc".into(),
            config_path_sha256: sha256_hex(b"/mock/config/path"),
            pid: 12345,
            audit_path: dir.join("permission_audit.jsonl"),
        }
    }

    #[test]
    fn sha256_hex_is_64_lowercase_hex() {
        let h = sha256_hex(b"hello");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        // Known SHA256("hello")
        assert_eq!(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn append_decision_writes_one_jsonl_line() {
        let dir = TempDir::new();
        let ctx = ctx_in(dir.path());
        append_decision(&ctx, "Bash", "fp1", "Bash: ls", "allow", "user_allow_once");
        let entries = read_all(&ctx.audit_path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["session_id"], "sid-abc");
        assert_eq!(entries[0]["tool"], "Bash");
        assert_eq!(entries[0]["decision"], "allow");
        assert_eq!(entries[0]["reason"], "user_allow_once");
        assert_eq!(entries[0]["pid"], 12345);
        assert!(entries[0]["ts_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn append_decision_entries_carry_config_path_sha256() {
        let dir = TempDir::new();
        let ctx = ctx_in(dir.path());
        let expected = sha256_hex(b"/mock/config/path");
        append_decision(&ctx, "Bash", "fp", "Bash: ls", "allow", "user_allow_once");
        let entries = read_all(&ctx.audit_path);
        assert_eq!(entries[0]["config_path_sha256"], expected);
    }

    #[test]
    fn append_decision_appends_does_not_overwrite() {
        let dir = TempDir::new();
        let ctx = ctx_in(dir.path());
        append_decision(&ctx, "Bash",  "fp1", "Bash: ls", "allow", "user_allow_once");
        append_decision(&ctx, "Write", "fp2", "Write: /tmp/x.txt", "deny", "user_deny");
        append_decision(&ctx, "Bash",  "fp3", "Bash: rm", "deny", "timeout");
        let entries = read_all(&ctx.audit_path);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["tool"], "Bash");
        assert_eq!(entries[1]["tool"], "Write");
        assert_eq!(entries[2]["tool"], "Bash");
        assert_eq!(entries[0]["reason"], "user_allow_once");
        assert_eq!(entries[1]["reason"], "user_deny");
        assert_eq!(entries[2]["reason"], "timeout");
    }

    #[test]
    fn append_decision_truncates_display_at_200_chars() {
        let dir = TempDir::new();
        let ctx = ctx_in(dir.path());
        let long = "x".repeat(500);
        append_decision(&ctx, "Bash", "fp", &long, "allow", "user_allow_once");
        let entries = read_all(&ctx.audit_path);
        let display = entries[0]["display"].as_str().unwrap();
        // 200 chars + ellipsis char
        assert_eq!(display.chars().count(), 201);
        assert!(display.ends_with('…'));
    }

    #[test]
    fn append_decision_creates_parent_dir_if_missing() {
        let dir = TempDir::new();
        let path = dir.path().join("nested/deeper/audit.jsonl");
        let ctx = AuditCtx {
            session_id: "s".into(),
            config_path_sha256: "h".into(),
            pid: 1,
            audit_path: path.clone(),
        };
        append_decision(&ctx, "Bash", "fp", "Bash: ls", "allow", "x");
        assert!(path.exists());
    }

    #[test]
    fn append_decision_survives_unwritable_path_without_panic() {
        let ctx = AuditCtx {
            session_id: "s".into(),
            config_path_sha256: "h".into(),
            pid: 1,
            // /proc on macOS doesn't exist → error goes to stderr, function returns cleanly.
            audit_path: PathBuf::from("/this/path/does/not/exist/and/cant/be/created/audit.jsonl"),
        };
        // Should not panic:
        append_decision(&ctx, "Bash", "fp", "Bash: ls", "allow", "x");
    }

    #[test]
    fn entries_are_valid_jsonl_each_line_parses_independently() {
        let dir = TempDir::new();
        let ctx = ctx_in(dir.path());
        for i in 0..10 {
            append_decision(&ctx, "Bash", "fp", &format!("cmd {}", i), "allow", "user_allow_once");
        }
        let raw = fs::read_to_string(&ctx.audit_path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 10);
        for l in lines {
            let v: Value = serde_json::from_str(l).expect("each line must be valid JSON");
            assert_eq!(v["tool"], "Bash");
        }
    }
}
