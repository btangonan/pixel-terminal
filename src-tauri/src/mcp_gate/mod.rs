//! mcp_gate — Rust port of anima_gate.py.
//!
//! Stdio MCP server (NDJSON JSON-RPC). Used with
//! `--permission-prompt-tool mcp__anima_<sid8>__approve` to gate tool calls
//! through the Anima UI. Protocol/IPC semantics match the Python reference
//! 1:1 so P2.D can replay fixtures through either engine.
//!
//! IPC files (session-scoped via ANIMA_SESSION):
//!   ~/.local/share/pixel-terminal/anima_gate_{session}.json          — request
//!   ~/.local/share/pixel-terminal/anima_gate_{session}_response.json — response
//!   ~/.local/share/pixel-terminal/pixel_terminal_alive                — heartbeat
//!
//! P2.E: persistent "allow always" check. Before prompting the UI we consult
//! `storage::permissions.json`; on hit, the gate auto-allows WITHOUT touching
//! the request file. On a `{approved:true, action:"allow_always"}` response
//! we persist a grant before replying allow.

pub mod storage;

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TIMEOUT_S: u64 = 60;
pub const POLL_MS: u64 = 300;
pub const ALIVE_MAX_S: u64 = 15;

pub struct GatePaths {
    pub request: PathBuf,
    pub response: PathBuf,
    pub alive: PathBuf,
    pub permissions: PathBuf,
}

impl GatePaths {
    pub fn for_session(ipc_dir: &PathBuf, session_id: &str) -> Self {
        Self {
            request: ipc_dir.join(format!("anima_gate_{}.json", session_id)),
            response: ipc_dir.join(format!("anima_gate_{}_response.json", session_id)),
            alive: ipc_dir.join("pixel_terminal_alive"),
            permissions: ipc_dir.join("permissions.json"),
        }
    }
}

pub fn default_ipc_dir() -> std::io::Result<PathBuf> {
    let home = std::env::var("HOME")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotFound, "HOME not set"))?;
    let p = PathBuf::from(home).join(".local/share/pixel-terminal");
    fs::create_dir_all(&p)?;
    Ok(p)
}

pub fn default_session_id() -> String {
    std::env::var("ANIMA_SESSION").unwrap_or_else(|_| "default".to_string())
}

fn ts_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn ts_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn is_terminal_alive(paths: &GatePaths) -> bool {
    let Ok(meta) = fs::metadata(&paths.alive) else { return false; };
    let Ok(mod_t) = meta.modified() else { return false; };
    match SystemTime::now().duration_since(mod_t) {
        Ok(d) => d.as_secs() < ALIVE_MAX_S,
        Err(_) => true, // file mtime in future (clock skew) — treat as alive
    }
}

pub fn display_for(tool_name: &str, tool_input: &Value) -> String {
    match tool_name {
        "Bash" => {
            let cmd = tool_input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let short: String = cmd.chars().take(120).collect();
            format!("Bash: {}", short)
        }
        "Write" | "Edit" | "MultiEdit" => {
            let fpath = tool_input.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
            format!("{}: {}", tool_name, fpath)
        }
        other => other.to_string(),
    }
}

fn send<W: Write>(writer: &mut W, obj: Value) -> std::io::Result<()> {
    let raw = serde_json::to_string(&obj)?;
    writer.write_all(raw.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn embed_result_text(msg_id: &Value, inner: Value) -> Value {
    let text = serde_json::to_string(&inner).unwrap_or_else(|_| "{}".to_string());
    json!({
        "jsonrpc": "2.0",
        "id": msg_id,
        "result": {
            "content": [{ "type": "text", "text": text }]
        }
    })
}

pub fn build_deny(msg_id: &Value, reason: &str) -> Value {
    embed_result_text(msg_id, json!({ "behavior": "deny", "message": reason }))
}

pub fn build_allow(msg_id: &Value, updated_input: &Value) -> Value {
    embed_result_text(msg_id, json!({ "behavior": "allow", "updatedInput": updated_input }))
}

/// Write atomically via tmp + rename. Returns the request id.
pub fn write_request(paths: &GatePaths, tool_name: &str, tool_input: &Value, display: &str) -> std::io::Result<String> {
    let req_id = format!("gate-{}", ts_ms());
    let req = json!({
        "id": &req_id,
        "tool": tool_name,
        "msg": display,
        "input": tool_input,
        "expires": ts_secs() + TIMEOUT_S,
        "ts": ts_secs(),
    });
    let tmp = paths.request.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(&req)?)?;
    fs::rename(&tmp, &paths.request)?;
    Ok(req_id)
}

/// Core permission-prompt handler. Writes a request file, polls response,
/// emits the JSON-RPC reply. Testable via the test module (mocks stdin/stdout).
pub fn handle_permission<W: Write>(
    writer: &mut W,
    msg_id: &Value,
    arguments: &Value,
    paths: &GatePaths,
    poll_ms: u64,
    timeout_s: u64,
) -> std::io::Result<()> {
    let tool_name = arguments.get("tool_name").and_then(|v| v.as_str()).unwrap_or("unknown");
    let tool_input = arguments.get("input").cloned().unwrap_or(json!({}));
    let display = display_for(tool_name, &tool_input);

    // P2.E: persistent "allow always" short-circuit. Runs BEFORE the alive
    // check on purpose — a user-approved entry should keep working even if
    // the UI is momentarily unreachable (e.g. window just refocused).
    // A corrupt or unreadable permissions file returns an empty store;
    // `is_allowed` then returns false and we fall through to the UI path.
    if storage::is_allowed_on_disk(&paths.permissions, tool_name, &tool_input) {
        return send(writer, build_allow(msg_id, &tool_input));
    }

    if !is_terminal_alive(paths) {
        return send(writer, build_deny(msg_id, "Anima UI not available for approval"));
    }

    let _ = fs::remove_file(&paths.response);

    let req_id = write_request(paths, tool_name, &tool_input, &display)?;

    let deadline = Instant::now() + Duration::from_secs(timeout_s);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(poll_ms));
        let Ok(raw) = fs::read_to_string(&paths.response) else { continue; };
        let Ok(resp): Result<Value, _> = serde_json::from_str(&raw) else { continue; };
        let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id != req_id { continue; }
        let approved = resp.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
        let action = resp.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let _ = fs::remove_file(&paths.response);
        let _ = fs::remove_file(&paths.request);
        if approved {
            // P2.E: persist on allow_always. Persistence failure is logged
            // via stderr but does NOT block this single-call allow — a write
            // race on permissions.json shouldn't cost the user the decision
            // they just made. Next session's modal will ask again.
            if action == "allow_always" {
                if let Err(e) = storage::grant_on_disk(
                    &paths.permissions,
                    tool_name,
                    &tool_input,
                    storage::DEFAULT_TTL_SECS,
                ) {
                    eprintln!("mcp_gate: grant_on_disk failed: {}", e);
                }
            }
            return send(writer, build_allow(msg_id, &tool_input));
        } else {
            return send(writer, build_deny(msg_id, "User denied"));
        }
    }

    let _ = fs::remove_file(&paths.request);
    send(writer, build_deny(msg_id, &format!("Approval timeout after {}s", timeout_s)))
}

/// Full MCP server loop. Reads NDJSON JSON-RPC from reader, writes to writer.
pub fn run<R: Read, W: Write>(reader: R, mut writer: W, paths: &GatePaths) -> std::io::Result<()> {
    let reader = BufReader::new(reader);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim();
        if line.is_empty() { continue; }

        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let msg_id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(json!({}));

        match method {
            "initialize" => {
                send(&mut writer, json!({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "anima-gate", "version": "1.0.0" }
                    }
                }))?;
            }
            "notifications/initialized" => { /* no reply */ }
            "tools/list" => {
                send(&mut writer, json!({
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "result": {
                        "tools": [{
                            "name": "approve",
                            "description": "Handle permission prompts for tool approval",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "tool_name": { "type": "string" },
                                    "input": { "type": "object" },
                                    "tool_use_id": { "type": "string" }
                                }
                            }
                        }]
                    }
                }))?;
            }
            "tools/call" => {
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                handle_permission(&mut writer, &msg_id, &args, paths, POLL_MS, TIMEOUT_S)?;
            }
            _ => {
                if !msg_id.is_null() {
                    send(&mut writer, json!({
                        "jsonrpc": "2.0",
                        "id": msg_id,
                        "result": {}
                    }))?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn tmp_paths() -> (tempdir_lite::TempDir, GatePaths) {
        let dir = tempdir_lite::TempDir::new();
        let paths = GatePaths::for_session(&dir.path().to_path_buf(), "testsession");
        (dir, paths)
    }

    #[test]
    fn display_for_bash_truncates_long_commands_to_120_chars() {
        let input = json!({ "command": "x".repeat(500) });
        let got = display_for("Bash", &input);
        assert!(got.starts_with("Bash: "));
        assert_eq!(got.len(), "Bash: ".len() + 120);
    }

    #[test]
    fn display_for_file_tools_includes_file_path() {
        let input = json!({ "file_path": "/tmp/x.rs" });
        assert_eq!(display_for("Write",     &input), "Write: /tmp/x.rs");
        assert_eq!(display_for("Edit",      &input), "Edit: /tmp/x.rs");
        assert_eq!(display_for("MultiEdit", &input), "MultiEdit: /tmp/x.rs");
    }

    #[test]
    fn display_for_unknown_tool_is_just_name() {
        assert_eq!(display_for("Whatever", &json!({})), "Whatever");
    }

    #[test]
    fn build_allow_emits_behavior_allow_with_updated_input() {
        let resp = build_allow(&json!(42), &json!({ "file_path": "/a" }));
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let inner: Value = serde_json::from_str(text).unwrap();
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["file_path"], "/a");
        assert_eq!(resp["id"], 42);
    }

    #[test]
    fn build_deny_emits_behavior_deny_with_reason() {
        let resp = build_deny(&json!("abc"), "nope");
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let inner: Value = serde_json::from_str(text).unwrap();
        assert_eq!(inner["behavior"], "deny");
        assert_eq!(inner["message"], "nope");
    }

    #[test]
    fn is_terminal_alive_false_when_file_missing() {
        let (_dir, paths) = tmp_paths();
        assert!(!is_terminal_alive(&paths));
    }

    #[test]
    fn is_terminal_alive_true_when_file_fresh() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();
        assert!(is_terminal_alive(&paths));
    }

    #[test]
    fn write_request_writes_atomically_with_tool_name_and_input() {
        let (_dir, paths) = tmp_paths();
        let input = json!({ "command": "ls" });
        let req_id = write_request(&paths, "Bash", &input, "Bash: ls").unwrap();
        let raw = fs::read_to_string(&paths.request).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["id"], req_id);
        assert_eq!(parsed["tool"], "Bash");
        assert_eq!(parsed["msg"], "Bash: ls");
        assert_eq!(parsed["input"]["command"], "ls");
        assert!(parsed["expires"].as_u64().unwrap() > parsed["ts"].as_u64().unwrap());
    }

    #[test]
    fn run_responds_to_initialize_with_protocol_version() {
        let (_dir, paths) = tmp_paths();
        let input = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_string() + "\n";
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out, &paths).unwrap();
        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(resp["result"]["serverInfo"]["name"], "anima-gate");
    }

    #[test]
    fn run_responds_to_tools_list_with_approve_tool() {
        let (_dir, paths) = tmp_paths();
        let input = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.to_string() + "\n";
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out, &paths).unwrap();
        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "approve");
        assert!(tools[0]["inputSchema"]["properties"]["tool_name"].is_object());
    }

    #[test]
    fn run_skips_blank_lines_and_malformed_json() {
        let (_dir, paths) = tmp_paths();
        let input = concat!(
            "\n",
            "not json at all\n",
            r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#, "\n",
        ).to_string();
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out, &paths).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1);
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(resp["id"], 7);
    }

    #[test]
    fn run_echoes_empty_result_for_unknown_method_with_id() {
        let (_dir, paths) = tmp_paths();
        let input = r#"{"jsonrpc":"2.0","id":99,"method":"ping"}"#.to_string() + "\n";
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out, &paths).unwrap();
        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(resp["id"], 99);
        assert_eq!(resp["result"], json!({}));
    }

    #[test]
    fn run_does_not_respond_to_notifications_initialized() {
        let (_dir, paths) = tmp_paths();
        let input = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_string() + "\n";
        let mut out = Vec::new();
        run(Cursor::new(input), &mut out, &paths).unwrap();
        assert!(out.is_empty(), "got: {:?}", String::from_utf8(out));
    }

    #[test]
    fn handle_permission_denies_when_terminal_not_alive() {
        let (_dir, paths) = tmp_paths();
        // No alive file written → not alive
        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(1),
            &json!({ "tool_name": "Bash", "input": { "command": "ls" } }),
            &paths,
            1, 1,
        ).unwrap();
        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "deny");
        assert!(inner["message"].as_str().unwrap().contains("not available"));
    }

    #[test]
    fn handle_permission_allows_on_approved_response() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();

        // Spawn a "UI" thread that writes an approved response after the request appears.
        let req_path = paths.request.clone();
        let resp_path = paths.response.clone();
        let ui = thread::spawn(move || {
            for _ in 0..50 {
                if let Ok(raw) = fs::read_to_string(&req_path) {
                    if let Ok(req) = serde_json::from_str::<Value>(&raw) {
                        let id = req["id"].as_str().unwrap().to_string();
                        fs::write(&resp_path, serde_json::to_string(&json!({
                            "id": id, "approved": true
                        })).unwrap()).unwrap();
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(1),
            &json!({ "tool_name": "Bash", "input": { "command": "ls" } }),
            &paths,
            20, 5,
        ).unwrap();
        ui.join().unwrap();

        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["command"], "ls");
    }

    #[test]
    fn handle_permission_denies_on_user_deny_response() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();

        let req_path = paths.request.clone();
        let resp_path = paths.response.clone();
        let ui = thread::spawn(move || {
            for _ in 0..50 {
                if let Ok(raw) = fs::read_to_string(&req_path) {
                    if let Ok(req) = serde_json::from_str::<Value>(&raw) {
                        let id = req["id"].as_str().unwrap().to_string();
                        fs::write(&resp_path, serde_json::to_string(&json!({
                            "id": id, "approved": false
                        })).unwrap()).unwrap();
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(2),
            &json!({ "tool_name": "Bash", "input": { "command": "ls" } }),
            &paths,
            20, 5,
        ).unwrap();
        ui.join().unwrap();

        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "deny");
        assert_eq!(inner["message"], "User denied");
    }

    #[test]
    fn handle_permission_times_out_when_no_response_arrives() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();

        let mut out = Vec::new();
        let start = std::time::Instant::now();
        handle_permission(
            &mut out,
            &json!(3),
            &json!({ "tool_name": "Bash", "input": { "command": "ls" } }),
            &paths,
            50, 1, // 1s timeout
        ).unwrap();
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_secs(1), "should have waited full timeout, got {:?}", elapsed);

        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "deny");
        assert!(inner["message"].as_str().unwrap().contains("timeout"));

        // Request file should be cleaned up on timeout
        assert!(!paths.request.exists(), "request file should be removed on timeout");
    }

    // ── P2.E — allow-always persistence integration ─────────────────────

    #[test]
    fn handle_permission_short_circuits_on_disk_allow_always() {
        let (_dir, paths) = tmp_paths();
        // NO alive file and NO response-writing thread. If the short-circuit
        // is working, we never consult alive and never write the request.
        let tool_input = json!({ "command": "ls" });
        storage::grant_on_disk(
            &paths.permissions, "Bash", &tool_input, storage::DEFAULT_TTL_SECS,
        ).unwrap();

        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(10),
            &json!({ "tool_name": "Bash", "input": &tool_input }),
            &paths,
            50, 1,
        ).unwrap();

        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(
            resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "allow");
        assert_eq!(inner["updatedInput"]["command"], "ls");
        // Proof we didn't go through the UI path:
        assert!(!paths.request.exists(), "no UI request should have been written");
    }

    #[test]
    fn handle_permission_allow_always_persists_on_approval() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();

        // UI thread: on seeing the request, reply approved + action=allow_always.
        let req_path = paths.request.clone();
        let resp_path = paths.response.clone();
        let ui = thread::spawn(move || {
            for _ in 0..50 {
                if let Ok(raw) = fs::read_to_string(&req_path) {
                    if let Ok(req) = serde_json::from_str::<Value>(&raw) {
                        let id = req["id"].as_str().unwrap().to_string();
                        fs::write(&resp_path, serde_json::to_string(&json!({
                            "id": id, "approved": true, "action": "allow_always",
                        })).unwrap()).unwrap();
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let tool_input = json!({ "command": "ls" });
        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(11),
            &json!({ "tool_name": "Bash", "input": &tool_input }),
            &paths,
            20, 5,
        ).unwrap();
        ui.join().unwrap();

        // The allow reply went out.
        let text = String::from_utf8(out).unwrap();
        let resp: Value = serde_json::from_str(text.trim()).unwrap();
        let inner: Value = serde_json::from_str(
            resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["behavior"], "allow");

        // And the grant is now persisted.
        assert!(storage::is_allowed_on_disk(&paths.permissions, "Bash", &tool_input));

        // Second identical call: no UI thread this time, no alive even — must short-circuit.
        fs::remove_file(&paths.alive).unwrap();
        let mut out2 = Vec::new();
        handle_permission(
            &mut out2,
            &json!(12),
            &json!({ "tool_name": "Bash", "input": &tool_input }),
            &paths,
            50, 1,
        ).unwrap();
        let text2 = String::from_utf8(out2).unwrap();
        let resp2: Value = serde_json::from_str(text2.trim()).unwrap();
        let inner2: Value = serde_json::from_str(
            resp2["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner2["behavior"], "allow");
    }

    #[test]
    fn handle_permission_allow_once_does_not_persist() {
        let (_dir, paths) = tmp_paths();
        fs::write(&paths.alive, "x").unwrap();

        let req_path = paths.request.clone();
        let resp_path = paths.response.clone();
        let ui = thread::spawn(move || {
            for _ in 0..50 {
                if let Ok(raw) = fs::read_to_string(&req_path) {
                    if let Ok(req) = serde_json::from_str::<Value>(&raw) {
                        let id = req["id"].as_str().unwrap().to_string();
                        fs::write(&resp_path, serde_json::to_string(&json!({
                            "id": id, "approved": true, "action": "allow_once",
                        })).unwrap()).unwrap();
                        return;
                    }
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let tool_input = json!({ "command": "ls" });
        let mut out = Vec::new();
        handle_permission(
            &mut out,
            &json!(13),
            &json!({ "tool_name": "Bash", "input": &tool_input }),
            &paths,
            20, 5,
        ).unwrap();
        ui.join().unwrap();

        // Not persisted — the next call must still require UI.
        assert!(!storage::is_allowed_on_disk(&paths.permissions, "Bash", &tool_input));
    }
}

// Tiny in-crate temp dir so we don't need a new dev-dep.
#[cfg(test)]
mod tempdir_lite {
    use std::fs;
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            let base = std::env::temp_dir();
            let pid = std::process::id();
            let nonce: u128 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = base.join(format!("animagate-test-{}-{}", pid, nonce));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }
        pub fn path(&self) -> &Path { &self.0 }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
