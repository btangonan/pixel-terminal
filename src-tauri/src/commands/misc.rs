use std::collections::HashSet;
use std::fs;
use std::sync::Mutex;

/// Tauri State: set of child PIDs this app has spawned. Used to restrict send_signal.
pub(crate) struct SpawnedPids(pub(crate) Mutex<HashSet<u32>>);

impl SpawnedPids {
    pub(crate) fn new() -> Self {
        SpawnedPids(Mutex::new(HashSet::new()))
    }
}

#[derive(serde::Serialize)]
pub(crate) struct SlashCommand {
    pub name: String,
    pub description: String,
}

/// Strip YAML frontmatter (--- block) from markdown content.
fn strip_frontmatter(content: &str) -> String {
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..];
            return after.trim_start_matches('\n').to_string();
        }
    }
    content.to_string()
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

fn collect_commands(dir: &str, prefix: Option<&str>, out: &mut Vec<SlashCommand>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
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

/// Read the full body of a slash command file by its frontmatter name.
#[tauri::command]
pub fn read_slash_command_content(name: String) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    find_command_content(&dir, &name, None)
}

/// Read ~/.claude/commands/ recursively and return name+description from frontmatter.
#[tauri::command]
pub fn read_slash_commands() -> Vec<SlashCommand> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    let mut commands = Vec::new();
    collect_commands(&dir, None, &mut commands);
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

/// Register a child PID that this app has spawned. Required before send_signal accepts it.
#[tauri::command]
pub fn register_child_pid(state: tauri::State<SpawnedPids>, pid: u32) {
    state.0.lock().unwrap().insert(pid);
}

/// Unregister a child PID (call when the child exits).
#[tauri::command]
pub fn unregister_child_pid(state: tauri::State<SpawnedPids>, pid: u32) {
    state.0.lock().unwrap().remove(&pid);
}

/// Send a POSIX signal to a process by PID.
/// Restricted to PIDs registered via register_child_pid.
/// Only SIGINT (2) and SIGTERM (15) are accepted.
#[tauri::command]
pub fn send_signal(state: tauri::State<SpawnedPids>, pid: u32, signal: i32) -> Result<(), String> {
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
pub fn js_log(msg: String) {
    println!("[webview] {}", msg);
}
