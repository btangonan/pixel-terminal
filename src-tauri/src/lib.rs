use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::sync::Mutex;
extern crate libc;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

mod ws_bridge;
use ws_bridge::{get_voice_status, ptt_release, ptt_start, set_omi_listening, set_voice_mode, switch_voice_source, sync_omi_sessions};

/// Tauri State: set of child PIDs this app has spawned. Used to restrict send_signal.
struct SpawnedPids(Mutex<HashSet<u32>>);

/// Validate and expand a path for use in IPC file commands.
/// Expands leading `~/`. Enforces a strict allowlist of paths the app
/// legitimately accesses — everything else is rejected.
///
/// Allowed prefixes (directories):
///   ~/Projects/                          — project files, attachment reads
///   ~/.config/pixel-terminal/            — buddy.json, project-chars.json
///   ~/.local/share/pixel-terminal/       — vexil_feed.jsonl, oracle_query.json
///   /tmp/                                — vexil IPC files, hook gate, alive marker
///
/// Allowed exact paths:
///   ~/.claude.json                       — companion reads Claude config
fn expand_and_validate_path(path: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME env not set".to_string())?;

    // Block obvious traversal sequences before expansion
    if path.contains("/../") || path.ends_with("/..") || path.starts_with("../") {
        return Err("Path traversal not allowed".to_string());
    }

    // Expand leading ~/
    let expanded = if path.starts_with("~/") {
        format!("{}/{}", home, &path[2..])
    } else if path == "~" {
        home.clone()
    } else {
        path.to_string()
    };

    // Require absolute path after expansion
    if !expanded.starts_with('/') {
        return Err("Relative paths not allowed".to_string());
    }

    // Strict allowlist — only paths the app has legitimate business accessing
    let allowed_dirs = [
        format!("{}/Projects/", home),
        format!("{}/.config/pixel-terminal/", home),
        format!("{}/.local/share/pixel-terminal/", home),
    ];
    let allowed_exact = [
        format!("{}/.claude.json", home),
    ];

    let in_allowed_dir = allowed_dirs.iter().any(|d| expanded.starts_with(d.as_str()));
    let is_allowed_exact = allowed_exact.iter().any(|e| expanded == e.as_str());
    let in_tmp = expanded.starts_with("/tmp/");

    if !in_allowed_dir && !is_allowed_exact && !in_tmp {
        return Err(format!("Path outside allowed prefixes: {}", path));
    }

    Ok(std::path::PathBuf::from(expanded))
}

#[derive(serde::Serialize)]
struct SlashCommand {
    name: String,
    description: String,
}

/// Strip YAML frontmatter (--- block) from markdown content.
fn strip_frontmatter(content: &str) -> String {
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..]; // skip past "\n---"
            return after.trim_start_matches('\n').to_string();
        }
    }
    content.to_string()
}

/// Read a file as a base64-encoded string (for images/binary).
#[tauri::command]
fn read_file_as_base64(path: String) -> Result<String, String> {
    let safe = expand_and_validate_path(&path)?;
    let bytes = fs::read(&safe).map_err(|e| e.to_string())?;
    Ok(encode_base64(&bytes))
}

/// Read a file as UTF-8 text.
#[tauri::command]
fn read_file_as_text(path: String) -> Result<String, String> {
    let safe = expand_and_validate_path(&path)?;
    fs::read_to_string(&safe).map_err(|e| e.to_string())
}

/// Write UTF-8 text to a file (creates parent dirs if needed).
#[tauri::command]
fn write_file_as_text(path: String, content: String) -> Result<(), String> {
    let safe = expand_and_validate_path(&path)?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&safe, content.as_bytes()).map_err(|e| e.to_string())
}

/// Atomically append a single line to a file (O_APPEND — safe for concurrent writers).
#[tauri::command]
fn append_line_to_file(path: String, line: String) -> Result<(), String> {
    let safe = expand_and_validate_path(&path)?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&safe)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", line).map_err(|e| e.to_string())
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut iter = input.chunks_exact(3);
    for chunk in iter.by_ref() {
        let (b0, b1, b2) = (chunk[0] as usize, chunk[1] as usize, chunk[2] as usize);
        out.push(TABLE[(b0 >> 2) & 0x3f] as char);
        out.push(TABLE[((b0 << 4) | (b1 >> 4)) & 0x3f] as char);
        out.push(TABLE[((b1 << 2) | (b2 >> 6)) & 0x3f] as char);
        out.push(TABLE[b2 & 0x3f] as char);
    }
    match iter.remainder() {
        [b0] => {
            let b0 = *b0 as usize;
            out.push(TABLE[(b0 >> 2) & 0x3f] as char);
            out.push(TABLE[(b0 << 4) & 0x3f] as char);
            out.push_str("==");
        }
        [b0, b1] => {
            let (b0, b1) = (*b0 as usize, *b1 as usize);
            out.push(TABLE[(b0 >> 2) & 0x3f] as char);
            out.push(TABLE[((b0 << 4) | (b1 >> 4)) & 0x3f] as char);
            out.push(TABLE[(b1 << 2) & 0x3f] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// Read the full body of a slash command file by its frontmatter name.
/// Scans ~/.claude/commands/ (one level of subdirs), matches by name: field,
/// returns content with frontmatter stripped. Returns None if not found.
#[tauri::command]
fn read_slash_command_content(name: String) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    find_command_content(&dir, &name, None)
}

fn find_command_content(dir: &str, target: &str, prefix: Option<&str>) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
            let ns = path.file_name()?.to_str()?.to_string();
            let subdir = path.to_string_lossy().to_string();
            if let Some(content) = find_command_content(&subdir, target, Some(&ns)) {
                return Some(content);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Some(cmd) = parse_frontmatter(&content) {
                let full_name = match prefix {
                    Some(ns) => format!("{}:{}", ns, cmd.name),
                    None => cmd.name,
                };
                if full_name == target {
                    return Some(strip_frontmatter(&content));
                }
            }
        }
    }
    None
}

/// Read ~/.claude/commands/ recursively (one level of subdirs) and return
/// name+description from YAML frontmatter. Subdir commands are prefixed:
/// sm/introspect.md → name "sm:introspect"
#[tauri::command]
fn read_slash_commands() -> Vec<SlashCommand> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    let mut commands = Vec::new();

    collect_commands(&dir, None, &mut commands);
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

fn collect_commands(dir: &str, prefix: Option<&str>, out: &mut Vec<SlashCommand>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
            // Recurse one level: folder name becomes the namespace prefix
            let ns = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let subdir = path.to_string_lossy().to_string();
            collect_commands(&subdir, Some(&ns), out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Some(mut cmd) = parse_frontmatter(&content) {
                if let Some(ns) = prefix {
                    cmd.name = format!("{}:{}", ns, cmd.name);
                }
                out.push(cmd);
            }
        }
    }
}

fn parse_frontmatter(content: &str) -> Option<SlashCommand> {
    let inner = content.strip_prefix("---\n")?.split("\n---").next()?;
    let name = inner.lines()
        .find(|l| l.starts_with("name:"))?
        .trim_start_matches("name:")
        .trim()
        .to_string();
    let desc_line = inner.lines()
        .find(|l| l.starts_with("description:"))?
        .trim_start_matches("description:")
        .trim()
        .trim_matches('"')
        .to_string();
    Some(SlashCommand { name, description: desc_line })
}

// ── Session History ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct SessionHistoryEntry {
    session_id: String,
    file_path: String,
    file_size: u64,
    slug: Option<String>,
    first_user_message: Option<String>,
    timestamp_start: Option<String>,
    timestamp_end: Option<String>,
    message_count: Option<u32>,
}

#[derive(serde::Serialize, Debug)]
struct SessionHistoryMessage {
    msg_type: String,
    text: Option<String>,
    tool_name: Option<String>,
    tool_id: Option<String>,
    tool_input: Option<String>,
}

/// Encode a filesystem path to Claude's project directory naming convention.
/// e.g. "/Users/foo/Projects/bar" → "-Users-foo-Projects-bar"
fn encode_project_path(path: &str) -> String {
    path.replace('/', "-")
}

/// Extract plain text from a JSON `message.content` value (string or array-of-blocks).
fn extract_content_text(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => {
            let trimmed = s.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }
        serde_json::Value::Array(arr) => {
            let text: String = arr.iter()
                .filter_map(|block| {
                    if block.get("type")?.as_str()? == "text" {
                        block.get("text")?.as_str().map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() { None } else { Some(text.trim().to_string()) }
        }
        _ => None,
    }
}

/// Scan ~/.claude/projects/{encoded_path}/ for *.jsonl session files.
/// Extracts metadata via head/tail reading — avoids parsing full large files.
#[tauri::command]
async fn scan_session_history(project_path: String) -> Result<Vec<SessionHistoryEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        let encoded = encode_project_path(&project_path);
        let dir = format!("{}/.claude/projects/{}", home, encoded);

        let read_dir = match fs::read_dir(&dir) {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()), // directory may not exist
        };

        let mut entries: Vec<SessionHistoryEntry> = Vec::new();

        for entry in read_dir.flatten() {
            let path = entry.path();
            // Skip directories (subagent folders) and non-jsonl files
            if path.is_dir() { continue; }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }

            let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let file_path = path.to_string_lossy().to_string();
            let file_size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

            let mut timestamp_start: Option<String> = None;
            let mut timestamp_end: Option<String> = None;
            let mut slug: Option<String> = None;
            let mut first_user_message: Option<String> = None;
            let mut message_count: Option<u32> = None;

            // ── HEAD: first 10 lines ─────────────────────────────────────────
            if let Ok(file) = fs::File::open(&path) {
                let reader = BufReader::new(file);
                for line in reader.lines().take(10).flatten() {
                    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Extract start timestamp from any line that has one
                        if timestamp_start.is_none() {
                            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                                timestamp_start = Some(ts.to_string());
                            }
                        }
                        // First user message text
                        if first_user_message.is_none() {
                            if obj.get("type").and_then(|v| v.as_str()) == Some("user") {
                                if let Some(content) = obj.get("message").and_then(|m| m.get("content")) {
                                    if let Some(text) = extract_content_text(content) {
                                        // Strip XML-style system tags (command messages etc.)
                                        let clean = regex_strip_xml_tags(&text);
                                        let preview = clean.trim().chars().take(200).collect::<String>();
                                        if !preview.is_empty() {
                                            first_user_message = Some(preview);
                                        }
                                    }
                                }
                            }
                        }
                        if timestamp_start.is_some() && first_user_message.is_some() { break; }
                    }
                }
            }

            // ── TAIL: last 8KB ───────────────────────────────────────────────
            if let Ok(mut file) = fs::File::open(&path) {
                let tail_size = 8192u64;
                let seek_pos = file_size.saturating_sub(tail_size);
                let _ = file.seek(SeekFrom::Start(seek_pos));
                let mut tail_buf = String::new();
                let _ = file.read_to_string(&mut tail_buf);

                // Parse lines in reverse to find most recent turn_duration + last timestamp
                let lines: Vec<&str> = tail_buf.lines().collect();
                for line in lines.iter().rev() {
                    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
                        if timestamp_end.is_none() {
                            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                                timestamp_end = Some(ts.to_string());
                            }
                        }
                        if slug.is_none() || message_count.is_none() {
                            if obj.get("type").and_then(|v| v.as_str()) == Some("system")
                                && obj.get("subtype").and_then(|v| v.as_str()) == Some("turn_duration")
                            {
                                if slug.is_none() {
                                    slug = obj.get("slug").and_then(|v| v.as_str()).map(|s| s.to_string());
                                }
                                if message_count.is_none() {
                                    message_count = obj.get("messageCount").and_then(|v| v.as_u64()).map(|n| n as u32);
                                }
                            }
                        }
                        if timestamp_end.is_some() && slug.is_some() && message_count.is_some() { break; }
                    }
                }
            }

            entries.push(SessionHistoryEntry {
                session_id,
                file_path,
                file_size,
                slug,
                first_user_message,
                timestamp_start,
                timestamp_end,
                message_count,
            });
        }

        // Sort newest first
        entries.sort_by(|a, b| {
            b.timestamp_start.as_deref().unwrap_or("").cmp(a.timestamp_start.as_deref().unwrap_or(""))
        });

        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Strip `<tag>...</tag>` style XML blocks from text (used in Claude system messages).
fn regex_strip_xml_tags(text: &str) -> String {
    // Simple state-machine strip: remove content between < and >
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    let mut depth = 0i32;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            // Peek ahead: is this a known system tag?
            let rest: String = chars[i..].iter().collect();
            if rest.starts_with("<system-reminder") || rest.starts_with("<command-") || rest.starts_with("<local-command") {
                in_tag = true;
                depth += 1;
                i += 1;
                continue;
            }
        }
        if in_tag {
            if chars[i] == '<' { depth += 1; }
            if chars[i] == '>' { depth -= 1; if depth <= 0 { in_tag = false; } }
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Fully parse a JSONL session file and return structured messages for rendering.
/// Restricted to files under ~/.claude/projects/ — the only legitimate source of session files.
#[tauri::command]
async fn load_session_history(file_path: String) -> Result<Vec<SessionHistoryMessage>, String> {
    // Validate before spawning — reject arbitrary paths from webview JS
    let home = std::env::var("HOME").map_err(|_| "HOME env not set".to_string())?;
    let allowed_prefix = format!("{}/.claude/projects/", home);
    if file_path.contains("/../") || file_path.ends_with("/..") {
        return Err("Path traversal not allowed".to_string());
    }
    if !file_path.starts_with(&allowed_prefix) {
        return Err("Session files must be under ~/.claude/projects/".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let file = fs::File::open(&file_path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);
        let mut messages: Vec<SessionHistoryMessage> = Vec::new();

        for line in reader.lines().flatten() {
            let obj: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let msg_type = match obj.get("type").and_then(|v| v.as_str()) {
                Some(t) => t,
                None => continue,
            };

            match msg_type {
                "user" => {
                    // Skip isMeta messages (synthetic/internal)
                    if obj.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false) { continue; }
                    if let Some(content) = obj.get("message").and_then(|m| m.get("content")) {
                        if let Some(text) = extract_content_text(content) {
                            let clean = regex_strip_xml_tags(&text);
                            if !clean.trim().is_empty() {
                                messages.push(SessionHistoryMessage {
                                    msg_type: "user".to_string(),
                                    text: Some(clean.trim().to_string()),
                                    tool_name: None,
                                    tool_id: None,
                                    tool_input: None,
                                });
                            }
                        }
                    }
                }
                "assistant" => {
                    if let Some(content_arr) = obj.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
                        for block in content_arr {
                            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            match block_type {
                                "text" => {
                                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                                    if !text.is_empty() {
                                        messages.push(SessionHistoryMessage {
                                            msg_type: "claude".to_string(),
                                            text: Some(text),
                                            tool_name: None,
                                            tool_id: None,
                                            tool_input: None,
                                        });
                                    }
                                }
                                "tool_use" => {
                                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    // Skip internal/MCP tools
                                    if name.starts_with("mcp__") { continue; }
                                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let input = block.get("input")
                                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                                        .unwrap_or_default();
                                    messages.push(SessionHistoryMessage {
                                        msg_type: "tool".to_string(),
                                        text: None,
                                        tool_name: Some(name),
                                        tool_id: Some(id),
                                        tool_input: Some(input),
                                    });
                                }
                                // Skip "thinking" blocks
                                _ => {}
                            }
                        }
                    }
                }
                _ => continue, // skip system, file-history-snapshot, etc.
            }
        }

        Ok(messages)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Register a child PID that this app has spawned. Required before send_signal accepts it.
#[tauri::command]
fn register_child_pid(state: tauri::State<SpawnedPids>, pid: u32) {
    state.0.lock().unwrap().insert(pid);
}

/// Unregister a child PID (call when the child exits).
#[tauri::command]
fn unregister_child_pid(state: tauri::State<SpawnedPids>, pid: u32) {
    state.0.lock().unwrap().remove(&pid);
}

/// Send a POSIX signal to a process by PID.
/// Restricted to PIDs registered via register_child_pid (must be a child this app spawned).
/// Only SIGINT (2) and SIGTERM (15) are accepted.
#[tauri::command]
fn send_signal(state: tauri::State<SpawnedPids>, pid: u32, signal: i32) -> Result<(), String> {
    const ALLOWED_SIGNALS: [i32; 2] = [2, 15]; // SIGINT, SIGTERM
    if !ALLOWED_SIGNALS.contains(&signal) {
        return Err(format!("Signal {} not allowed (permitted: SIGINT=2, SIGTERM=15)", signal));
    }
    {
        let pids = state.0.lock().unwrap();
        if !pids.contains(&pid) {
            return Err(format!("PID {} is not a registered child process", pid));
        }
    }
    let ret = unsafe { libc::kill(pid as i32, signal) };
    if ret == 0 {
        Ok(())
    } else {
        Err(format!("kill({}, {}) failed: errno {}", pid, signal, unsafe { *libc::__error() }))
    }
}

/// Forward JS console.log to terminal for debugging.
#[tauri::command]
fn js_log(msg: String) {
    println!("[webview] {}", msg);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpawnedPids(Mutex::new(HashSet::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            ws_bridge::init(app)?;

            // Custom menu — replaces "About pixel-terminal" with "About Pixel Claude"
            // and intercepts the About action to show our styled dialog.
            let about_i = MenuItem::with_id(app, "about", "About Pixel Claude", true, None::<&str>)?;
            let app_menu = Submenu::with_items(app, "Pixel Claude", true, &[
                &about_i,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            let edit_menu = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            let window_menu = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id() == "about" {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit("show-about", ());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_as_base64,
            read_file_as_text,
            read_slash_commands,
            read_slash_command_content,
            sync_omi_sessions,
            set_omi_listening,
            set_voice_mode,
            ptt_start,
            ptt_release,
            switch_voice_source,
            get_voice_status,
            scan_session_history,
            load_session_history,
            register_child_pid,
            unregister_child_pid,
            send_signal,
            js_log,
            write_file_as_text,
            append_line_to_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Set dock icon in Ready — runs AFTER Tauri's internal setApplicationIconImage
            // (tauri-2/src/app.rs RuntimeRunEvent::Ready), so our contentView wins.
            if let tauri::RunEvent::Ready = event {
                #[cfg(target_os = "macos")]
                set_squircle_dock_icon();
            }
        });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_traversal_blocked() {
        let result = expand_and_validate_path("../../../etc/passwd");
        assert!(result.is_err(), "path traversal should be rejected");
        let msg = result.unwrap_err();
        assert!(msg.contains("traversal") || msg.contains("Relative"), "got: {}", msg);
    }

    #[test]
    fn test_system_path_blocked() {
        let result = expand_and_validate_path("/etc/passwd");
        assert!(result.is_err(), "system path should be rejected");
    }

    #[test]
    fn test_home_root_blocked() {
        // ~/some-file at home root (not in an allowed subdir) should be rejected
        let result = expand_and_validate_path("~/secret.txt");
        assert!(result.is_err(), "home-root file outside allowlist should be rejected");
    }

    #[test]
    fn test_ssh_key_blocked() {
        let result = expand_and_validate_path("~/.ssh/id_rsa");
        assert!(result.is_err(), "~/.ssh/ should be rejected");
    }

    #[test]
    fn test_config_pixel_terminal_allowed() {
        let result = expand_and_validate_path("~/.config/pixel-terminal/buddy.json");
        assert!(result.is_ok(), "~/.config/pixel-terminal/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_local_share_pixel_terminal_allowed() {
        let result = expand_and_validate_path("~/.local/share/pixel-terminal/vexil_feed.jsonl");
        assert!(result.is_ok(), "~/.local/share/pixel-terminal/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_projects_allowed() {
        let result = expand_and_validate_path("~/Projects/my-project/file.txt");
        assert!(result.is_ok(), "~/Projects/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_tmp_allowed() {
        let result = expand_and_validate_path("/tmp/pixel_terminal_alive");
        assert!(result.is_ok(), "/tmp/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_claude_json_exact_allowed() {
        let result = expand_and_validate_path("~/.claude.json");
        assert!(result.is_ok(), "~/.claude.json exact path should be allowed: {:?}", result);
    }

    #[test]
    fn test_write_file_rejects_system_path() {
        let result = write_file_as_text("/etc/hosts".to_string(), "evil".to_string());
        assert!(result.is_err(), "writes outside allowed paths should be rejected");
    }

    #[test]
    fn test_read_file_rejects_traversal() {
        let result = read_file_as_text("../../../etc/passwd".to_string());
        assert!(result.is_err(), "path traversal should be rejected by read_file_as_text");
    }

    #[test]
    fn test_absolute_home_path_blocked() {
        // Construct a path like /Users/foo/Desktop — not in allowlist
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{}/Desktop/evil.txt", home);
        let result = expand_and_validate_path(&path);
        assert!(result.is_err(), "~/Desktop/ should be rejected: {:?}", result);
    }

    // load_session_history path validation
    #[tokio::test]
    async fn test_load_session_history_rejects_arbitrary_path() {
        let result = load_session_history("/etc/passwd".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("~/.claude/projects/"), "got: {}", msg);
    }

    #[tokio::test]
    async fn test_load_session_history_rejects_traversal() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{}/.claude/projects/../../../etc/passwd", home);
        let result = load_session_history(path).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_load_session_history_accepts_valid_project_path() {
        let home = std::env::var("HOME").unwrap_or_default();
        // Valid prefix — will fail with file-not-found, NOT a path rejection error
        let path = format!("{}/.claude/projects/test-project/abc123.jsonl", home);
        let result = load_session_history(path).await;
        // Should be an IO error (file not found), not a path validation rejection
        if let Err(e) = &result {
            assert!(!e.contains("~/.claude/projects/"), "unexpected path rejection: {}", e);
        }
    }
}

/// ─── DOCK ICON — READ BEFORE TOUCHING ────────────────────────────────────────
///
/// WHY THIS IS IN run() AND NOT setup():
///   Tauri v2 calls setApplicationIconImage() internally on RuntimeRunEvent::Ready,
///   which fires AFTER setup(). Anything set in setup() is silently overridden.
///   This function must be called from RunEvent::Ready in the app.run() callback.
///
/// WHY NSDockTile.contentView (NOT setApplicationIconImage):
///   setApplicationIconImage composites the image on an opaque background,
///   stripping alpha transparency → transparent-corner PNGs render as squares.
///   contentView renders an NSView directly, preserving alpha.
///
/// WHY icon_master_1024_rounded.png (NOT icon_master_1024.png):
///   NSDockTile.contentView BYPASSES macOS 26 Tahoe squircle enforcement.
///   The system does NOT apply its squircle mask to contentView content.
///   The squircle must be pre-baked into the PNG (transparent corners).
///   icon_master_1024.png is the flat square — wrong file for this path.
///
/// AFTER CHANGING THE PNG: touch src-tauri/src/lib.rs before rebuilding.
///   include_bytes! is resolved at compile time; cargo won't recompile if only
///   the PNG changed. Skipping the touch = old icon bytes silently re-used.
///
/// See CLAUDE.md §"Dock Icon System" for full context.
/// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
fn set_squircle_dock_icon() {
    use cocoa::appkit::NSImage;
    use cocoa::base::nil;
    use cocoa::foundation::{NSData, NSPoint, NSRect, NSSize};
    use objc::runtime::Object;
    use objc::*;

    // Pre-baked squircle PNG — transparent corners. NSImageView preserves alpha;
    // setApplicationIconImage composites opaquely and loses it.
    let icon_bytes: &[u8] = include_bytes!("../icons/icon_master_1024_rounded.png");

    unsafe {
        let ns_data = NSData::dataWithBytes_length_(
            nil,
            icon_bytes.as_ptr() as *const std::ffi::c_void,
            icon_bytes.len() as u64,
        );
        let ns_image: *mut Object = msg_send![class!(NSImage), alloc];
        let ns_image: *mut Object = msg_send![ns_image, initWithData: ns_data];
        let _: () = msg_send![ns_image, setSize: NSSize::new(1024.0, 1024.0)];

        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let dock_tile: *mut Object = msg_send![ns_app, dockTile];

        let frame = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: 128.0, height: 128.0 },
        };
        let image_view: *mut Object = msg_send![class!(NSImageView), alloc];
        let image_view: *mut Object = msg_send![image_view, initWithFrame: frame];
        let _: () = msg_send![image_view, setImageScaling: 3u64]; // NSImageScaleProportionallyUpOrDown
        let _: () = msg_send![image_view, setImage: ns_image];
        let _: () = msg_send![dock_tile, setContentView: image_view];
        let _: () = msg_send![dock_tile, display];
    }
}
