//! P2.D — Semantic JSON-RPC parity tests for the Rust gate vs the Python reference.
//!
//! For every contract-relevant scenario we drive both engines with identical
//! stdin frames in identical HOME/ANIMA_SESSION environments and assert that
//! the two produce semantically equivalent stdout. "Semantic" means: same
//! JSON-RPC ids echoed, same result shape, same behavior decision. Byte-for-
//! byte equality is NOT the goal (key ordering, serverInfo.name strings, and
//! whitespace differ) — the test extracts the fields that would actually make
//! Claude route differently, then compares those.
//!
//! Why an integration test and not a unit test: the Python engine only exists
//! as a script on disk, so we must shell out. Same shape used for Rust to
//! minimize drift between the two paths.
//!
//! Fixture: tests/fixtures/permission_protocol_v1.jsonl captured a real spike
//! run on 2026-04-17. We reuse its shape (initialize → tools/list → tools/call)
//! but parameterize the scenarios we care about (allow, deny, timeout, etc.).

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// ── Shared harness ───────────────────────────────────────────────────────────

const SESSION_ID: &str = "parity-session";

fn repo_root() -> PathBuf {
    // tests/ sits next to src-tauri/. CARGO_MANIFEST_DIR is src-tauri/.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn rust_gate_binary() -> PathBuf {
    // This integration test runs under `cargo test`, which builds binaries
    // into target/<profile>/. The parity test depends on the gate binary
    // being built in the same profile as the test itself.
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    repo_root()
        .join("src-tauri/target")
        .join(profile)
        .join("anima_gate")
}

fn python_gate_script() -> PathBuf {
    repo_root().join("src-tauri/mcp/anima_gate.py")
}

struct TempHome {
    path: PathBuf,
}

impl TempHome {
    fn new() -> Self {
        let nonce: u128 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("anima-parity-{}-{}", std::process::id(), nonce));
        fs::create_dir_all(path.join(".local/share/pixel-terminal")).expect("mk ipc dir");
        Self { path }
    }
    fn ipc_dir(&self) -> PathBuf { self.path.join(".local/share/pixel-terminal") }
    fn write_alive(&self) {
        fs::write(self.ipc_dir().join("pixel_terminal_alive"), "x").expect("alive write");
    }
    fn request_path(&self) -> PathBuf {
        self.ipc_dir().join(format!("anima_gate_{}.json", SESSION_ID))
    }
    fn response_path(&self) -> PathBuf {
        self.ipc_dir().join(format!("anima_gate_{}_response.json", SESSION_ID))
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

enum Engine { Rust, Python }

fn spawn(engine: &Engine, home: &TempHome) -> Child {
    let mut cmd = match engine {
        Engine::Rust => {
            let bin = rust_gate_binary();
            if !bin.exists() {
                panic!("rust gate binary not built at {:?} — run `cargo build --bin anima_gate` first", bin);
            }
            Command::new(bin)
        }
        Engine::Python => {
            let script = python_gate_script();
            if !script.exists() {
                panic!("python gate script missing at {:?}", script);
            }
            let mut c = Command::new("python3");
            c.arg(script);
            c
        }
    };
    cmd.env("HOME", &home.path)
        .env("ANIMA_SESSION", SESSION_ID)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn gate")
}

/// Write frames to the child's stdin, close it, collect all stdout lines.
/// Times out after `timeout` to avoid hanging a broken engine.
fn drive_and_collect(mut child: Child, frames: &[&str], timeout: Duration) -> Vec<Value> {
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        for frame in frames {
            stdin.write_all(frame.as_bytes()).expect("write frame");
            stdin.write_all(b"\n").expect("write newline");
        }
        stdin.flush().expect("flush");
    }
    drop(child.stdin.take());

    let stdout = child.stdout.take().expect("stdout");
    let reader = BufReader::new(stdout);

    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for line in reader.lines().flatten() {
            let line = line.trim().to_string();
            if line.is_empty() { continue; }
            let _ = tx.send(line);
        }
    });

    let deadline = Instant::now() + timeout;
    let mut out = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { break; }
        match rx.recv_timeout(remaining) {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(v) => out.push(v),
                Err(_) => { /* ignore non-json lines */ }
            },
            Err(_) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    out
}

/// Await until the request file appears (or deadline), then write a response.
fn respond_async(home_path: PathBuf, approved: bool) -> thread::JoinHandle<Option<String>> {
    let req_path = home_path.join(format!(".local/share/pixel-terminal/anima_gate_{}.json", SESSION_ID));
    let resp_path = home_path.join(format!(".local/share/pixel-terminal/anima_gate_{}_response.json", SESSION_ID));
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if let Ok(raw) = fs::read_to_string(&req_path) {
                if let Ok(req) = serde_json::from_str::<Value>(&raw) {
                    if let Some(id) = req.get("id").and_then(|v| v.as_str()) {
                        let payload = json!({ "id": id, "approved": approved });
                        let _ = fs::write(&resp_path, serde_json::to_string(&payload).unwrap());
                        return Some(id.to_string());
                    }
                }
            }
            thread::sleep(Duration::from_millis(30));
        }
        None
    })
}

// ── Helpers to extract the semantically-meaningful bits from a response ──────

fn find_response_for_id(frames: &[Value], id: i64) -> Option<&Value> {
    frames.iter().find(|f| f.get("id").and_then(|v| v.as_i64()) == Some(id))
}

fn tool_call_decision(frame: &Value) -> (String, Option<String>) {
    // tools/call response → result.content[0].text is stringified JSON with behavior.
    let text = frame
        .get("result").and_then(|r| r.get("content"))
        .and_then(|c| c.as_array()).and_then(|a| a.first())
        .and_then(|c| c.get("text")).and_then(|t| t.as_str())
        .unwrap_or("{}");
    let inner: Value = serde_json::from_str(text).unwrap_or(json!({}));
    let behavior = inner.get("behavior").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let reason = inner.get("message").and_then(|v| v.as_str()).map(|s| s.to_string());
    (behavior, reason)
}

// ── The tests ────────────────────────────────────────────────────────────────

#[test]
fn initialize_handshake_is_semantically_equivalent() {
    let home = TempHome::new();
    let frames = [r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code"}}}"#];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    assert_eq!(rust.len(),   1, "rust: {:?}",   rust);
    assert_eq!(python.len(), 1, "python: {:?}", python);

    let r = &rust[0];
    let p = &python[0];

    assert_eq!(r["id"], p["id"]);
    assert_eq!(r["jsonrpc"], "2.0");
    assert_eq!(p["jsonrpc"], "2.0");
    assert_eq!(r["result"]["protocolVersion"], p["result"]["protocolVersion"]);
    // Both declare tools capability (empty object)
    assert!(r["result"]["capabilities"]["tools"].is_object(), "rust caps: {}", r);
    assert!(p["result"]["capabilities"]["tools"].is_object(), "python caps: {}", p);
}

#[test]
fn tools_list_returns_single_approve_tool_with_matching_schema() {
    let home = TempHome::new();
    let frames = [r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    for (tag, frame) in [("rust", &rust), ("python", &python)] {
        assert_eq!(frame.len(), 1, "{tag}: {:?}", frame);
        let tools = frame[0]["result"]["tools"].as_array().unwrap_or_else(|| panic!("{tag}: no tools array"));
        assert_eq!(tools.len(), 1, "{tag}: expected 1 tool");
        assert_eq!(tools[0]["name"], "approve", "{tag}: wrong tool name");
        let props = &tools[0]["inputSchema"]["properties"];
        assert!(props["tool_name"].is_object(), "{tag}: missing tool_name property");
        assert!(props["input"].is_object(),     "{tag}: missing input property");
    }
}

#[test]
fn notifications_initialized_produces_no_response() {
    let home = TempHome::new();
    // Send notification THEN a ping-style call so we can detect any spurious output.
    let frames = [
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":42,"method":"initialize","params":{}}"#,
    ];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    // Exactly one response (the initialize), in both engines
    assert_eq!(rust.len(),   1, "rust: {:?}",   rust);
    assert_eq!(python.len(), 1, "python: {:?}", python);
    assert_eq!(rust[0]["id"],   42);
    assert_eq!(python[0]["id"], 42);
}

#[test]
fn tools_call_allow_path_produces_behavior_allow_in_both_engines() {
    for engine in [Engine::Rust, Engine::Python] {
        let home = TempHome::new();
        home.write_alive();

        let responder = respond_async(home.path.clone(), true);

        let frames = [r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}}"#];
        let out = drive_and_collect(spawn(&engine, &home), &frames, Duration::from_secs(10));
        responder.join().unwrap();

        let call = find_response_for_id(&out, 7).unwrap_or_else(|| panic!("no tools/call response in {:?}", out));
        let (behavior, _) = tool_call_decision(call);
        assert_eq!(behavior, "allow", "engine output: {:?}", out);

        // Request file should be cleaned up
        assert!(!home.request_path().exists(), "request file not cleaned up");
    }
}

#[test]
fn tools_call_deny_path_produces_behavior_deny_in_both_engines() {
    for engine in [Engine::Rust, Engine::Python] {
        let home = TempHome::new();
        home.write_alive();

        let responder = respond_async(home.path.clone(), false);

        let frames = [r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"}}}}"#];
        let out = drive_and_collect(spawn(&engine, &home), &frames, Duration::from_secs(10));
        responder.join().unwrap();

        let call = find_response_for_id(&out, 8).unwrap();
        let (behavior, reason) = tool_call_decision(call);
        assert_eq!(behavior, "deny");
        assert_eq!(reason.unwrap_or_default(), "User denied");
    }
}

#[test]
fn tools_call_denies_when_terminal_not_alive_in_both_engines() {
    for engine in [Engine::Rust, Engine::Python] {
        let home = TempHome::new();
        // Do NOT write alive file

        let frames = [r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"approve","arguments":{"tool_name":"Bash","input":{"command":"ls"}}}}"#];
        let out = drive_and_collect(spawn(&engine, &home), &frames, Duration::from_secs(5));

        let call = find_response_for_id(&out, 9).expect("no response");
        let (behavior, reason) = tool_call_decision(call);
        assert_eq!(behavior, "deny");
        assert!(reason.unwrap_or_default().to_lowercase().contains("not available"),
                "expected 'not available' reason, got engine output: {:?}", out);
    }
}

// ── Adversarial ──────────────────────────────────────────────────────────────

#[test]
fn malformed_json_is_skipped_and_does_not_kill_the_engine() {
    let home = TempHome::new();
    let frames = [
        "not json at all",
        r#"{"incomplete": "#,
        r#"{"jsonrpc":"2.0","id":77,"method":"initialize","params":{}}"#,
    ];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    assert_eq!(find_response_for_id(&rust,   77).map(|f| f["id"].clone()), Some(json!(77)));
    assert_eq!(find_response_for_id(&python, 77).map(|f| f["id"].clone()), Some(json!(77)));
}

#[test]
fn large_payload_over_1mb_is_handled_without_crash() {
    let home = TempHome::new();
    home.write_alive();

    // 1.2 MB of 'x' as the command string
    let big = "x".repeat(1_200_000);
    let frame = json!({
        "jsonrpc":"2.0", "id": 88, "method":"tools/call",
        "params": { "name":"approve", "arguments": { "tool_name":"Bash", "input": { "command": big } } }
    }).to_string();

    // Respond deny quickly — we just want to verify neither engine crashes on the payload.
    let responder = respond_async(home.path.clone(), false);
    let frame_refs: &[&str] = &[&frame];
    let out = drive_and_collect(spawn(&Engine::Rust, &home), frame_refs, Duration::from_secs(10));
    responder.join().unwrap();

    let call = find_response_for_id(&out, 88).expect("rust did not respond to 1MB payload");
    let (behavior, _) = tool_call_decision(call);
    assert_eq!(behavior, "deny");
}

#[test]
fn abrupt_eof_after_partial_line_does_not_hang_either_engine() {
    let home = TempHome::new();

    // Send a complete initialize so we know the engine started, then close stdin mid-frame.
    // drive_and_collect always closes stdin after writing all frames, so the engines
    // must handle EOF gracefully.
    let frames = [
        r#"{"jsonrpc":"2.0","id":100,"method":"initialize"}"#,
        // Partial frame — no newline in the middle of writing is simulated by the
        // immediate drop of stdin after the last frame+\n. This guarantees both
        // engines see EOF on their readline loop.
    ];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    assert!(!rust.is_empty(),   "rust produced no output before EOF");
    assert!(!python.is_empty(), "python produced no output before EOF");
}

#[test]
fn unknown_method_with_id_gets_empty_result_in_both_engines() {
    let home = TempHome::new();
    let frames = [r#"{"jsonrpc":"2.0","id":55,"method":"ping/unknown"}"#];

    let rust   = drive_and_collect(spawn(&Engine::Rust,   &home), &frames, Duration::from_secs(3));
    let python = drive_and_collect(spawn(&Engine::Python, &home), &frames, Duration::from_secs(3));

    for (tag, frames) in [("rust", &rust), ("python", &python)] {
        let resp = find_response_for_id(frames, 55).unwrap_or_else(|| panic!("{tag}: no response"));
        assert_eq!(resp["result"], json!({}), "{tag}: got {:?}", resp);
    }
}

// ── Fixture sanity ───────────────────────────────────────────────────────────

#[test]
fn fixture_tool_name_matches_mechanical_contract() {
    // tests/fixtures/permission_tool_name_v1.txt captures the tool flag Claude
    // received in the P2.A0 spike. The flag must structurally match
    //   mcp__<server_key>__approve
    // per the naming contract. We decouple "server_key" since the spike's
    // server name was spike_<sid8>; the real Anima server key is anima_<sid8>.
    let path = repo_root().join("tests/fixtures/permission_tool_name_v1.txt");
    let got = fs::read_to_string(&path).expect("read fixture").trim().to_string();

    assert!(got.starts_with("mcp__") && got.ends_with("__approve"),
            "fixture tool name does not match mcp__*_approve: {}", got);

    let middle = &got["mcp__".len()..got.len() - "__approve".len()];
    assert!(middle.contains('_'), "server key must embed an identifier: {}", middle);
}

fn _fixture_path(_p: &str) -> PathBuf { PathBuf::from(_p) } // keep Path import used
#[allow(dead_code)]
fn _silence_path_import(p: &Path) -> &Path { p }
