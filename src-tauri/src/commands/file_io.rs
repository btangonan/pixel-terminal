use std::fs;
use std::io::Write;

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
pub(crate) fn expand_and_validate_path(path: &str) -> Result<std::path::PathBuf, String> {
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

/// Read a file as a base64-encoded string (for images/binary).
#[tauri::command]
pub fn read_file_as_base64(path: String) -> Result<String, String> {
    let safe = expand_and_validate_path(&path)?;
    let bytes = fs::read(&safe).map_err(|e| e.to_string())?;
    Ok(encode_base64(&bytes))
}

/// Read a file as UTF-8 text.
#[tauri::command]
pub fn read_file_as_text(path: String) -> Result<String, String> {
    let safe = expand_and_validate_path(&path)?;
    fs::read_to_string(&safe).map_err(|e| e.to_string())
}

/// Write UTF-8 text to a file (creates parent dirs if needed).
#[tauri::command]
pub fn write_file_as_text(path: String, content: String) -> Result<(), String> {
    let safe = expand_and_validate_path(&path)?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&safe, content.as_bytes()).map_err(|e| e.to_string())
}

/// Atomically append a single line to a file (O_APPEND — safe for concurrent writers).
#[tauri::command]
pub fn append_line_to_file(path: String, line: String) -> Result<(), String> {
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
