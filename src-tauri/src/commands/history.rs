use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

#[derive(serde::Serialize)]
pub(crate) struct SessionHistoryEntry {
    pub session_id: String,
    pub file_path: String,
    pub file_size: u64,
    pub slug: Option<String>,
    pub first_user_message: Option<String>,
    pub timestamp_start: Option<String>,
    pub timestamp_end: Option<String>,
    pub message_count: Option<u32>,
}

#[derive(serde::Serialize, Debug)]
pub(crate) struct SessionHistoryMessage {
    pub msg_type: String,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_id: Option<String>,
    pub tool_input: Option<String>,
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

/// Strip `<tag>...</tag>` style XML blocks from text (used in Claude system messages).
fn regex_strip_xml_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    let mut depth = 0i32;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
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

/// Scan ~/.claude/projects/{encoded_path}/ for *.jsonl session files.
/// Extracts metadata via head/tail reading — avoids parsing full large files.
#[tauri::command]
pub async fn scan_session_history(project_path: String) -> Result<Vec<SessionHistoryEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        let encoded = encode_project_path(&project_path);
        let dir = format!("{}/.claude/projects/{}", home, encoded);

        let read_dir = match fs::read_dir(&dir) {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };

        let mut entries: Vec<SessionHistoryEntry> = Vec::new();

        for entry in read_dir.flatten() {
            let path = entry.path();
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
                        if timestamp_start.is_none() {
                            if let Some(ts) = obj.get("timestamp").and_then(|v| v.as_str()) {
                                timestamp_start = Some(ts.to_string());
                            }
                        }
                        if first_user_message.is_none() {
                            if obj.get("type").and_then(|v| v.as_str()) == Some("user") {
                                if let Some(content) = obj.get("message").and_then(|m| m.get("content")) {
                                    if let Some(text) = extract_content_text(content) {
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

        entries.sort_by(|a, b| {
            b.timestamp_start.as_deref().unwrap_or("").cmp(a.timestamp_start.as_deref().unwrap_or(""))
        });

        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fully parse a JSONL session file and return structured messages for rendering.
/// Restricted to files under ~/.claude/projects/ — the only legitimate source of session files.
#[tauri::command]
pub async fn load_session_history(file_path: String) -> Result<Vec<SessionHistoryMessage>, String> {
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
                                _ => {}
                            }
                        }
                    }
                }
                _ => continue,
            }
        }

        Ok(messages)
    })
    .await
    .map_err(|e| e.to_string())?
}
