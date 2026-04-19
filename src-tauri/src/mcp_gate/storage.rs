//! P2.E — persistent "allow always" permission store.
//!
//! File: `~/.local/share/pixel-terminal/permissions.json`
//!
//! Schema (stable, forward-compatible):
//!   {
//!     "version": 1,
//!     "entries": [
//!       { "key": "<tool>:<sha256>", "tool": "...", "fingerprint": "<sha256>",
//!         "granted_at": <unix_s>, "expires_at": <unix_s> },
//!       ...
//!     ]
//!   }
//!
//! Fingerprint = SHA256(canonical_json(input_with_volatile_keys_stripped)).
//! Canonical JSON = serde_json::Value with maps recursively re-serialized
//! with sorted keys (BTreeMap). Matches Python's json.dumps(sort_keys=True)
//! so cross-engine fingerprints agree.
//!
//! Volatile keys stripped before hashing (re-added if tool-meaningful later):
//!   - tool_use_id          (Claude's per-call id, changes every invocation)
//!   - session_id           (already in our path scope)
//!
//! TTL: 30 days. An expired entry is treated as absent AND pruned lazily
//! on next read. `is_allowed` returns false for expired entries.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_TTL_SECS: u64 = 30 * 24 * 60 * 60; // 30 days
const SCHEMA_VERSION: u32 = 1;
const VOLATILE_KEYS: &[&str] = &["tool_use_id", "session_id"];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    pub tool: String,
    pub fingerprint: String,
    pub granted_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Store {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<Entry>,
}

impl Default for Store {
    fn default() -> Self {
        Self { version: SCHEMA_VERSION, entries: Vec::new() }
    }
}

fn default_version() -> u32 { SCHEMA_VERSION }

pub fn default_store_path() -> std::io::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME not set"))?;
    let dir = PathBuf::from(home).join(".local/share/pixel-terminal");
    fs::create_dir_all(&dir)?;
    Ok(dir.join("permissions.json"))
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Recursively canonicalize a Value by sorting every object's keys
/// and stripping VOLATILE_KEYS at every depth. Arrays preserve order.
fn canonicalize(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (k, vv) in m.iter() {
                if VOLATILE_KEYS.contains(&k.as_str()) { continue; }
                sorted.insert(k.clone(), canonicalize(vv));
            }
            let mut out = Map::new();
            for (k, vv) in sorted { out.insert(k, vv); }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// Deterministic fingerprint of a tool input, suitable for keying
/// "allow always" entries. Returns a lowercase 64-char hex SHA256.
pub fn fingerprint(tool_input: &Value) -> String {
    let canon = canonicalize(tool_input);
    let bytes = serde_json::to_vec(&canon).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(&bytes);
    let digest = h.finalize();
    let mut s = String::with_capacity(64);
    for b in digest.iter() {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

pub fn make_key(tool_name: &str, fp: &str) -> String {
    format!("{}:{}", tool_name, fp)
}

/// Load the store. Missing file = empty store (not an error).
/// Corrupt file = empty store with a log side-effect; we DO NOT fail open
/// into "auto-allow everything" just because the file is corrupt.
pub fn load(path: &Path) -> Store {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

/// Save atomically via tmp + rename.
pub fn save(path: &Path, store: &Store) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
    let serialized = serde_json::to_string_pretty(store)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serialized + "\n")?;
    fs::rename(&tmp, path)
}

/// Remove entries whose `expires_at <= now`. Returns the number removed.
pub fn prune_expired(store: &mut Store, now: u64) -> usize {
    let before = store.entries.len();
    store.entries.retain(|e| e.expires_at > now);
    before - store.entries.len()
}

/// True iff a non-expired entry exists for (tool_name, input).
pub fn is_allowed(store: &Store, tool_name: &str, tool_input: &Value, now: u64) -> bool {
    let fp = fingerprint(tool_input);
    let key = make_key(tool_name, &fp);
    store.entries.iter().any(|e| e.key == key && e.expires_at > now)
}

/// Insert or refresh an allow-always entry. Idempotent: if the key
/// already exists, expiry is bumped to `now + ttl_secs`.
pub fn grant(store: &mut Store, tool_name: &str, tool_input: &Value, now: u64, ttl_secs: u64) {
    let fp = fingerprint(tool_input);
    let key = make_key(tool_name, &fp);
    let expires_at = now + ttl_secs;
    if let Some(existing) = store.entries.iter_mut().find(|e| e.key == key) {
        existing.granted_at = now;
        existing.expires_at = expires_at;
        return;
    }
    store.entries.push(Entry {
        key,
        tool: tool_name.to_string(),
        fingerprint: fp,
        granted_at: now,
        expires_at,
    });
}

/// Convenience: load → check → return bool. Swallows load errors.
pub fn is_allowed_on_disk(path: &Path, tool_name: &str, tool_input: &Value) -> bool {
    let store = load(path);
    is_allowed(&store, tool_name, tool_input, now_s())
}

/// Convenience: load → grant → prune expired → save. Surface errors.
pub fn grant_on_disk(
    path: &Path,
    tool_name: &str,
    tool_input: &Value,
    ttl_secs: u64,
) -> std::io::Result<()> {
    let mut store = load(path);
    let now = now_s();
    grant(&mut store, tool_name, tool_input, now, ttl_secs);
    prune_expired(&mut store, now);
    store.version = SCHEMA_VERSION;
    save(path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    // Reuse the tiny temp-dir helper style from mcp_gate::tests.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            let pid = std::process::id();
            let nonce: u128 = SystemTime::now()
                .duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let p = base.join(format!("animastorage-test-{}-{}", pid, nonce));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn fingerprint_is_stable_across_key_order() {
        let a = json!({ "command": "ls /tmp", "cwd": "/home" });
        let b = json!({ "cwd": "/home", "command": "ls /tmp" });
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_is_stable_at_nested_depth() {
        let a = json!({ "outer": { "b": 2, "a": 1 }, "list": [1, 2, 3] });
        let b = json!({ "list": [1, 2, 3], "outer": { "a": 1, "b": 2 } });
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_ignores_volatile_keys_at_any_depth() {
        let a = json!({ "command": "ls", "tool_use_id": "toolu_abc" });
        let b = json!({ "command": "ls", "tool_use_id": "toolu_xyz" });
        assert_eq!(fingerprint(&a), fingerprint(&b));

        let nested_a = json!({ "outer": { "tool_use_id": "a", "cmd": "ls" } });
        let nested_b = json!({ "outer": { "tool_use_id": "b", "cmd": "ls" } });
        assert_eq!(fingerprint(&nested_a), fingerprint(&nested_b));
    }

    #[test]
    fn fingerprint_differs_when_substantive_field_differs() {
        let a = json!({ "command": "ls /tmp" });
        let b = json!({ "command": "rm -rf /" });
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_hex_length_is_64() {
        let fp = fingerprint(&json!({ "any": "input" }));
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn grant_then_is_allowed_returns_true() {
        let mut store = Store::default();
        let input = json!({ "command": "ls" });
        grant(&mut store, "Bash", &input, 1_000_000, DEFAULT_TTL_SECS);
        assert!(is_allowed(&store, "Bash", &input, 1_000_001));
    }

    #[test]
    fn is_allowed_false_without_grant() {
        let store = Store::default();
        assert!(!is_allowed(&store, "Bash", &json!({ "command": "ls" }), 0));
    }

    #[test]
    fn is_allowed_false_for_different_tool_same_input() {
        let mut store = Store::default();
        let input = json!({ "command": "ls" });
        grant(&mut store, "Bash", &input, 0, DEFAULT_TTL_SECS);
        assert!(!is_allowed(&store, "Write", &input, 1));
    }

    #[test]
    fn is_allowed_false_when_expired() {
        let mut store = Store::default();
        grant(&mut store, "Bash", &json!({"command":"ls"}), 0, 10);
        // Now = 11, expires_at = 10 → expired.
        assert!(!is_allowed(&store, "Bash", &json!({"command":"ls"}), 11));
        // And 10 exactly = boundary: expires_at > now must be STRICT.
        assert!(!is_allowed(&store, "Bash", &json!({"command":"ls"}), 10));
        // Now = 9 < 10 → still valid.
        assert!(is_allowed(&store, "Bash", &json!({"command":"ls"}), 9));
    }

    #[test]
    fn grant_is_idempotent_refreshes_expiry() {
        let mut store = Store::default();
        let input = json!({ "command": "ls" });
        grant(&mut store, "Bash", &input, 100, 10);
        assert_eq!(store.entries.len(), 1);
        grant(&mut store, "Bash", &input, 500, 10);
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].granted_at, 500);
        assert_eq!(store.entries[0].expires_at, 510);
    }

    #[test]
    fn prune_expired_removes_only_expired() {
        let mut store = Store::default();
        grant(&mut store, "Bash", &json!({"command":"a"}), 0, 10);   // expires 10
        grant(&mut store, "Bash", &json!({"command":"b"}), 0, 100);  // expires 100
        grant(&mut store, "Bash", &json!({"command":"c"}), 0, 5);    // expires 5
        let removed = prune_expired(&mut store, 50);
        assert_eq!(removed, 2);
        assert_eq!(store.entries.len(), 1);
        let remaining_input = json!({"command":"b"});
        let fp = fingerprint(&remaining_input);
        assert_eq!(store.entries[0].fingerprint, fp);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = TempDir::new();
        let path = dir.path().join("permissions.json");
        let mut store = Store::default();
        grant(&mut store, "Bash", &json!({"command":"ls"}), 1000, DEFAULT_TTL_SECS);
        save(&path, &store).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.version, SCHEMA_VERSION);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].tool, "Bash");
    }

    #[test]
    fn load_missing_file_returns_empty_store_not_error() {
        let dir = TempDir::new();
        let path = dir.path().join("does-not-exist.json");
        let store = load(&path);
        assert_eq!(store.entries.len(), 0);
    }

    #[test]
    fn load_corrupt_file_returns_empty_store_fail_closed() {
        let dir = TempDir::new();
        let path = dir.path().join("permissions.json");
        fs::write(&path, "this is not json").unwrap();
        let store = load(&path);
        // Corrupt file MUST NOT be interpreted as "allow everything".
        assert_eq!(store.entries.len(), 0);
    }

    #[test]
    fn grant_on_disk_then_is_allowed_on_disk() {
        let dir = TempDir::new();
        let path = dir.path().join("permissions.json");
        let input = json!({ "command": "ls" });
        grant_on_disk(&path, "Bash", &input, DEFAULT_TTL_SECS).unwrap();
        assert!(is_allowed_on_disk(&path, "Bash", &input));
        assert!(!is_allowed_on_disk(&path, "Bash", &json!({"command":"rm"})));
    }

    #[test]
    fn grant_on_disk_prunes_expired_on_write() {
        let dir = TempDir::new();
        let path = dir.path().join("permissions.json");
        // Manually write a store with an already-expired entry + one valid.
        let mut store = Store::default();
        store.entries.push(Entry {
            key: "Bash:oldfp".into(),
            tool: "Bash".into(),
            fingerprint: "oldfp".into(),
            granted_at: 0,
            expires_at: 1, // long expired by wall-clock
        });
        save(&path, &store).unwrap();
        grant_on_disk(&path, "Bash", &json!({"command":"ls"}), DEFAULT_TTL_SECS).unwrap();

        let reloaded = load(&path);
        // Expired entry pruned; new grant kept.
        assert_eq!(reloaded.entries.len(), 1);
        assert_eq!(reloaded.entries[0].tool, "Bash");
        assert_ne!(reloaded.entries[0].fingerprint, "oldfp");
    }

    #[test]
    fn make_key_format_is_tool_colon_fingerprint() {
        let fp = fingerprint(&json!({ "command": "ls" }));
        let key = make_key("Bash", &fp);
        assert!(key.starts_with("Bash:"));
        assert_eq!(key.len(), "Bash:".len() + 64);
    }
}
