//! daemon.rs — Vexil Master daemon (Rust port of scripts/vexil_master.py)
//!
//! Runs as a long-lived tokio task inside the Tauri app. Polls vexil_feed.jsonl
//! for events from all Claude sessions, detects patterns, and fires proactive
//! commentary by calling `claude -p` as a subprocess. Also handles oracle
//! pre-session chat by polling oracle_query.json (same file-protocol as Python).
//!
//! Drop-in compatible with the Python daemon — companion.js sees no difference
//! in vexil_master_out.jsonl format.
//!
//! ASYNC/MUTEX RULE: never hold std::sync::Mutex guard across .await.
//! Pattern: lock → clone/take data → drop guard → async work → lock → update.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt; // .ino() on macOS
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::sleep;

// ── Constants (mirrors vexil_master.py) ──────────────────────────────────────

const POLL_MS:                u64   = 1_000;
const COOLDOWN_S:             f64   = 60.0;
const TURN_COOLDOWN_S:        f64   = 20.0;
const TOKEN_BLOAT_THRESHOLD:  u64   = 80_000;
const RETRY_THRESHOLD:        usize = 3;
const READ_HEAVY_THRESHOLD:   usize = 5;
const READ_HEAVY_MIN_READS:   usize = 4;
const READ_HEAVY_WINDOW_S:    f64   = 90.0;
const FIRED_PATTERN_TTL_S:    f64   = 300.0;
const ACTIVITY_TRIGGER_CNT:   u32   = 8;
const ACTIVITY_RECENCY_S:     f64   = 120.0;
const ORIENTATION_SUPPRESS_S: f64   = 120.0;

const INTERNAL_TERMS: &[&str] = &[
    "companion.js", "vexil_master", "session-lifecycle", "session.js",
    "events.js", "cards.js", "voice.js", "attachments.js", "history.js",
    "app.js", "styles.css", "index.html", "dom.js", "messages.js",
    "buddy.json", "vexil_feed", "vexil_master_out", "vexil_lint",
    "pixel-terminal", "pixel_terminal", "LINT_LOG", "BUDDY tab",
    "FILES tab", "VOICE tab", "vexil-log", "vexil-bio",
];

const WRITE_TOOLS: &[&str] = &[
    "Write", "Edit", "MultiEdit", "Bash", "NotebookEdit",
    "mcp__figma", "mcp__github__create", "mcp__github__push", "mcp__github__merge",
];

const READ_TOOLS: &[&str] = &[
    "Read", "Grep", "Glob", "WebFetch", "WebSearch", "TodoRead", "TaskList", "TaskGet",
];

// ── Types ─────────────────────────────────────────────────────────────────────

// (ts_secs, tool_name, hint)
type ToolEntry = (f64, String, String);
// (ts_secs, tool_display, hint, opt_file, opt_cwd)
type ActEntry  = (f64, String, String, Option<String>, Option<String>);
// (ts_secs, user_msg, turn_text)
type ConvoEntry = (f64, String, String);

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DaemonState {
    tool_sequences:  HashMap<String, VecDeque<ToolEntry>>,
    recent_activity: HashMap<String, VecDeque<ActEntry>>,
    session_convo:   HashMap<String, VecDeque<ConvoEntry>>,
    session_born:    HashMap<String, f64>,
    fired_patterns:  HashMap<String, f64>,
    last_comment_ts: f64,
    last_comment_per: HashMap<String, f64>,
    tools_since:     u32,
    tool_errors:     HashMap<String, Vec<String>>,
    recent_actions:  VecDeque<String>,  // last 3 *action* strings
    // Feed reader state
    feed_offset: u64,
    feed_inode:  u64,
    // Oracle file-polling state
    oracle_mtime: f64,
}

pub struct DaemonShared {
    pub state:           Arc<Mutex<DaemonState>>,
    pub sem:             Arc<Semaphore>,
    pub commentary_busy: Arc<AtomicBool>,
    pub oracle_busy:     Arc<AtomicBool>,
}

impl DaemonShared {
    pub fn new() -> Arc<Self> {
        let mut initial = DaemonState::default();
        // Seed feed offset — skip events from before daemon started
        let feed = expand_home("~/.local/share/pixel-terminal/vexil_feed.jsonl");
        if let Ok(meta) = std::fs::metadata(&feed) {
            initial.feed_offset = meta.len();
            initial.feed_inode  = meta.ino();
        }
        Arc::new(Self {
            state:           Arc::new(Mutex::new(initial)),
            sem:             Arc::new(Semaphore::new(2)),
            commentary_busy: Arc::new(AtomicBool::new(false)),
            oracle_busy:     Arc::new(AtomicBool::new(false)),
        })
    }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

pub fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{}", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()), rest),
        None       => path.to_string(),
    }
}

fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn classify_tool(name: &str) -> &'static str {
    if WRITE_TOOLS.iter().any(|w| name.starts_with(w)) { return "write"; }
    let bare = if name.contains("__") { name.split("__").last().unwrap_or(name) } else { name };
    if READ_TOOLS.iter().any(|r| bare == *r || name == *r) { return "read"; }
    "other"
}

fn short_name(tool: &str) -> String {
    tool.replace("mcp__", "").replace("__", " ").replace('_', " ")
}

fn is_internal(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    INTERNAL_TERMS.iter().any(|t| lower.contains(&t.to_lowercase()))
}

// ── Config loaders ────────────────────────────────────────────────────────────

fn load_buddy() -> Value {
    let p = expand_home("~/.config/pixel-terminal/buddy.json");
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({"name":"Vexil","species":"dragon"}))
}

fn load_companion() -> Value {
    let p = expand_home("~/.claude.json");
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("companion").cloned())
        .unwrap_or_default()
}

fn reporting_mode() -> String {
    load_buddy().get("reportingMode")
        .and_then(|v| v.as_str()).unwrap_or("user").to_string()
}

fn str_val<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// Return `a` if non-empty, else `b`, else `default`.
fn coalesce<'a>(a: &'a str, b: &'a str, default: &'a str) -> &'a str {
    if !a.is_empty() { a } else if !b.is_empty() { b } else { default }
}

fn build_persona(recent_actions: &VecDeque<String>) -> String {
    let companion = load_companion();
    let buddy     = load_buddy();
    let name        = coalesce(str_val(&companion, "name"),        str_val(&buddy, "name"),        "Vexil");
    let personality = coalesce(str_val(&companion, "personality"), str_val(&buddy, "personality"), "");
    let mut p = format!(
        "{personality}\n\nYou watch across multiple Claude Code sessions and occasionally drop one line \
        in a speech bubble. You're not {name} — you're writing its line.\n\
        One physical action in asterisks, specific to this moment — never repeat the same action twice in a row.\n\
        Under 20 words total. Say what's wrong, not what's happening. No preamble."
    );
    if !recent_actions.is_empty() {
        let list: Vec<&str> = recent_actions.iter().map(|s| s.as_str()).collect();
        p.push_str(&format!("\nDo NOT use these recent actions: {}.", list.join(", ")));
    }
    p
}

fn build_oracle_system(sessions: &[Value]) -> String {
    let companion = load_companion();
    let buddy     = load_buddy();
    let name        = coalesce(str_val(&companion, "name"),        str_val(&buddy, "name"),        "Vexil");
    let personality = coalesce(str_val(&companion, "personality"), str_val(&buddy, "personality"), "");

    // Trait line
    let species   = str_val(&buddy, "species");
    let voice     = str_val(&buddy, "voice");
    let peak_stat = buddy.get("stats").and_then(|s| s.as_object()).and_then(|m| {
        m.iter().max_by(|a, b| {
            a.1.as_f64().unwrap_or(0.0).partial_cmp(&b.1.as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        }).map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
    });

    let mut trait_line = String::new();
    if !species.is_empty()                                     { trait_line.push_str(&format!("Species: {species}.")); }
    if !voice.is_empty() && voice != "default"                 { trait_line.push_str(&format!(" Voice: {voice}.")); }
    if let Some((ref stat, val)) = peak_stat { trait_line.push_str(&format!(" Peak trait: {stat} {val}/10.")); }

    if sessions.is_empty() {
        let mut ctx = if personality.is_empty() { String::new() } else { format!("{personality}\n\n") };
        if !trait_line.is_empty() { ctx.push_str(&trait_line); ctx.push('\n'); }
        ctx.push_str(&format!("You are {name}. No sessions open — you're blind right now. Tell the user to press + to open a project folder. One sentence."));
        return ctx;
    }

    let sessions_str: Vec<String> = sessions.iter().map(|s| {
        format!("{} ({})", str_val(s, "name"), str_val(s, "cwd"))
    }).collect();

    let mut ctx = if personality.is_empty() { String::new() } else { format!("{personality}\n\n") };
    ctx.push_str(&format!("You are {name}, watching Claude Code sessions.\nOpen sessions: {}.\n", sessions_str.join("; ")));
    if !trait_line.is_empty() { ctx.push_str(&trait_line); ctx.push('\n'); }
    ctx.push_str("\nAnswer directly from what you know. Be opinionated and specific. 2 sentences max. Cut to the insight, not the description.");
    ctx
}

// ── I/O ───────────────────────────────────────────────────────────────────────

async fn append_out(msg: &str) {
    let path = expand_home("~/.local/share/pixel-terminal/vexil_master_out.jsonl");
    let line = format!("{}\n", serde_json::json!({"msg": msg, "ts": now_ms()}));
    match tokio::fs::OpenOptions::new().append(true).create(true).open(&path).await {
        Ok(mut f) => { let _ = f.write_all(line.as_bytes()).await; }
        Err(e)    => eprintln!("[daemon] append_out error: {e}"),
    }
}

async fn append_out_raw(entry: Value) {
    let path = expand_home("~/.local/share/pixel-terminal/vexil_master_out.jsonl");
    let line = format!("{}\n", entry);
    match tokio::fs::OpenOptions::new().append(true).create(true).open(&path).await {
        Ok(mut f) => { let _ = f.write_all(line.as_bytes()).await; }
        Err(e)    => eprintln!("[daemon] append_out_raw error: {e}"),
    }
}

// Returns (new_entries, new_offset, new_inode).
// Does NOT hold any mutex — caller owns the offset/inode values.
async fn read_new_lines(path: &str, mut offset: u64, mut inode: u64) -> (Vec<Value>, u64, u64) {
    let mut entries = Vec::new();

    let meta = match tokio::fs::metadata(path).await {
        Ok(m)  => m,
        Err(_) => return (entries, offset, inode),
    };
    let cur_ino = meta.ino();
    if cur_ino != inode { offset = 0; inode = cur_ino; }
    if meta.len() < offset { offset = 0; }

    let mut file = match tokio::fs::OpenOptions::new().read(true).open(path).await {
        Ok(f)  => f,
        Err(_) => return (entries, offset, inode),
    };
    if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
        return (entries, offset, inode);
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).await.is_err() {
        return (entries, offset, inode);
    }

    // Advance offset only to last complete line — protects against partial writes
    let consumed = match buf.iter().rposition(|&b| b == b'\n') {
        Some(pos) => { offset += pos as u64 + 1; pos + 1 }
        None      => return (entries, offset, inode),
    };
    for raw in buf[..consumed].split(|&b| b == b'\n') {
        let raw = match std::str::from_utf8(raw) { Ok(s) => s.trim(), Err(_) => continue };
        if raw.is_empty() { continue; }
        if let Ok(v) = serde_json::from_str::<Value>(raw) { entries.push(v); }
    }
    (entries, offset, inode)
}

// ── Claude subprocess ─────────────────────────────────────────────────────────

async fn call_claude(prompt: String, model: &str, extra_args: &[&str], timeout_secs: u64, sem: &Arc<Semaphore>) -> Option<String> {
    let _permit = sem.acquire().await.ok()?;
    let mut cmd = Command::new("claude");
    cmd.arg("-p").arg("--model").arg(model);
    for a in extra_args { cmd.arg(a); }
    cmd.stdin(std::process::Stdio::piped())
       .stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c)  => c,
        Err(e) => { eprintln!("[daemon] spawn error: {e}"); return None; }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
    } // stdin drop → EOF
    match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Err(_)       => { eprintln!("[daemon] claude timeout ({timeout_secs}s)"); None }
        Ok(Err(e))   => { eprintln!("[daemon] wait error: {e}"); None }
        Ok(Ok(out))  => {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if s.is_empty() || s == "SKIP" { None } else { Some(s) }
            } else {
                let e = String::from_utf8_lossy(&out.stderr);
                eprintln!("[daemon] claude rc={} stderr={}", out.status, &e[..e.len().min(120)]);
                None
            }
        }
    }
}

// ── Pattern detection ─────────────────────────────────────────────────────────

fn check_tool_patterns(sid: &str, st: &DaemonState, now: f64) -> Option<(&'static str, Value)> {
    let seq = st.tool_sequences.get(sid)?;
    if seq.len() < RETRY_THRESHOLD { return None; }
    let v: Vec<&ToolEntry> = seq.iter().collect();
    let tools: Vec<&str>   = v.iter().map(|e| e.1.as_str()).collect();
    let hints: Vec<&str>   = v.iter().map(|e| e.2.as_str()).collect();

    // Retry loop
    let tail_t = &tools[tools.len() - RETRY_THRESHOLD..];
    if tail_t.iter().all(|&t| t == tail_t[0]) {
        let tail_h: Vec<&str> = hints[hints.len() - RETRY_THRESHOLD..].to_vec();
        return Some(("retry_loop", serde_json::json!({
            "tool": tail_t[0], "count": RETRY_THRESHOLD, "hints": tail_h, "session_id": sid,
        })));
    }

    // Read-heavy (suppressed during orientation window)
    let age = now - st.session_born.get(sid).copied().unwrap_or(now);
    if v.len() >= READ_HEAVY_THRESHOLD && age > ORIENTATION_SUPPRESS_S {
        let tail = &v[v.len() - READ_HEAVY_THRESHOLD..];
        let window_ok     = (now - tail[0].0) <= READ_HEAVY_WINDOW_S;
        let no_writes     = tail.iter().all(|e| classify_tool(&e.1) != "write");
        let enough_reads  = tail.iter().filter(|e| classify_tool(&e.1) == "read").count() >= READ_HEAVY_MIN_READS;
        if window_ok && no_writes && enough_reads {
            let tool_names: Vec<String> = tail.iter().map(|e| short_name(&e.1)).collect();
            let hint_strs:  Vec<&str>   = tail.iter().filter(|e| !e.2.is_empty()).map(|e| e.2.as_str()).collect();
            return Some(("read_heavy", serde_json::json!({
                "tools": tool_names, "hints": hint_strs, "count": READ_HEAVY_THRESHOLD, "session_id": sid,
            })));
        }
    }
    None
}

// ── Prompt builders ───────────────────────────────────────────────────────────

fn build_prompt(trigger: &str, data: &Value) -> Option<String> {
    match trigger {
        "turn_complete" => {
            let tc   = data["tool_count"].as_u64().unwrap_or(0);
            let tt   = data["turn_text"].as_str().unwrap_or("");
            let um   = data["user_msg"].as_str().unwrap_or("");
            let acts: Vec<String> = data["activity"].as_array().map(|a| a.iter().map(|e| {
                let t = e[0].as_str().unwrap_or(""); let h = e[1].as_str().unwrap_or("");
                if h.is_empty() { t.into() } else { format!("{t}({h})") }
            }).collect()).unwrap_or_default();
            let steps = acts.join(" → ");
            if !tt.is_empty() {
                Some(format!(
                    "<user_msg>{um}</user_msg>\n<claude_conclusion>{tt}</claude_conclusion>\n\
                    Tools: {steps} ({tc} tools).\n\n\
                    Write the next line for the companion. Drop ONE sharp observation — a pattern, a momentum shift, \
                    something interesting about what the user is building or where they're heading. \
                    Focus ONLY on the user's intent, workflow state, or project domain. \
                    Do NOT comment on Claude's internal bash commands, shell delays, or tool parameters. \
                    Do NOT give refactoring advice. Under 20 words. \
                    If you have nothing genuinely additive to say, output exactly: SKIP"
                ))
            } else {
                Some(format!(
                    "Tool sequence: {steps} ({tc} tools).\n\n\
                    Write the next line for the companion. Drop ONE sharp observation about what's happening — \
                    a pattern, a pivot, momentum. Do NOT give refactoring advice. Under 20 words. \
                    If you have nothing genuinely additive to say, output exactly: SKIP"
                ))
            }
        }
        "retry_loop" => {
            let tool  = short_name(data["tool"].as_str().unwrap_or("?"));
            let count = data["count"].as_u64().unwrap_or(3);
            let hints: Vec<&str> = data["hints"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            let ctx = if hints.is_empty() { "no detail".into() } else { hints.join(" → ") };
            Some(format!("'{tool}' called {count} times in a row. Context: {ctx}. What's broken that made this necessary?"))
        }
        "read_heavy" => {
            let count = data["count"].as_u64().unwrap_or(5);
            let hints: Vec<&str> = data["hints"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            let ctx = if hints.is_empty() { "no detail".into() } else { hints.join(" | ") };
            Some(format!("{count} reads, no writes. Files: {ctx}. Lost or avoiding the actual change?"))
        }
        "cross_session_error" => {
            let key  = data["key"].as_str().unwrap_or("?");
            let sids: Vec<&str> = data["sessions"].as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            Some(format!("Same error '{key}' in {} sessions ({}). What's the shared root?", sids.len(), sids.join(", ")))
        }
        "token_bloat" => {
            let tok = data["tokens"].as_u64().unwrap_or(0);
            Some(format!("Context is {tok} tokens — that's bloated. What could be summarized or pruned before the next turn?"))
        }
        "session_activity" => {
            let summary = data["summary"].as_str().unwrap_or("");
            Some(format!("Active across sessions: {summary}. What's the common thread?"))
        }
        _ => None,
    }
}

// ── Workers (spawned as tasks — no Mutex held across .await) ──────────────────

async fn commentary_worker(trigger: String, data: Value, persona: String, shared: Arc<DaemonShared>) {
    let Some(body) = build_prompt(&trigger, &data) else {
        shared.commentary_busy.store(false, Ordering::Relaxed);
        return;
    };
    let full = format!("{persona}\n\n{body}");
    let msg  = call_claude(full, "claude-sonnet-4-6", &[], 30, &shared.sem).await;

    if let Some(msg) = msg {
        if reporting_mode() != "dev" && is_internal(&msg) {
            println!("[daemon] suppressed internal ref: \"{}\"", &msg[..msg.len().min(80)]);
        } else {
            append_out(&msg).await;
            // Extract *action* to prevent repetition
            if let (Some(s), Some(e)) = (msg.find('*'), msg.rfind('*')) {
                if s < e {
                    let action = msg[s + 1..e].trim().to_string();
                    if let Ok(mut st) = shared.state.lock() {
                        st.recent_actions.push_back(action);
                        if st.recent_actions.len() > 3 { st.recent_actions.pop_front(); }
                        st.last_comment_ts = now_s();
                    }
                }
            } else {
                if let Ok(mut st) = shared.state.lock() { st.last_comment_ts = now_s(); }
            }
            println!("[daemon] {trigger} → \"{}\"", &msg[..msg.len().min(80)]);
        }
    }
    shared.commentary_busy.store(false, Ordering::Relaxed);
}

async fn oracle_worker(
    query:    Value,
    ra_snap:  HashMap<String, Vec<(f64, String, String)>>,
    cv_snap:  HashMap<String, Vec<ConvoEntry>>,
    shared:   Arc<DaemonShared>,
) {
    let now      = now_s();
    let sessions = query["sessions"].as_array().cloned().unwrap_or_default();
    let message  = query["message"].as_str().unwrap_or("").to_string();
    let history  = query["history"].as_array().cloned().unwrap_or_default();
    let req_id   = query["req_id"].clone();

    // Build live context
    let mut activity_lines = Vec::new();
    for (sid, acts) in &ra_snap {
        let filtered: Vec<&(f64, String, String)> = acts.iter()
            .filter(|(ts, _, _)| now - ts < 300.0).collect();
        let recent: Vec<String> = filtered.iter().rev().take(4).rev()
            .map(|(_, t, h)| if h.is_empty() { t.clone() } else { format!("{t}({h})") })
            .collect();
        if !recent.is_empty() {
            activity_lines.push(format!("  session {}: {}", &sid[..sid.len().min(8)], recent.join(", ")));
        }
    }

    // Most recently active session's last 2 turns
    let mut convo_lines = Vec::new();
    if let Some((_, turns)) = cv_snap.iter().max_by(|a, b| {
        let at = a.1.last().map(|e| e.0).unwrap_or(0.0);
        let bt = b.1.last().map(|e| e.0).unwrap_or(0.0);
        at.partial_cmp(&bt).unwrap_or(std::cmp::Ordering::Equal)
    }) {
        let last2: Vec<&ConvoEntry> = turns.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect();
        for (_, um, tt) in last2 {
            if !um.is_empty() { convo_lines.push(format!("USER: {}", &um[..um.len().min(300)])); }
            if !tt.is_empty() { convo_lines.push(format!("CLAUDE: {}", &tt[..tt.len().min(600)])); }
        }
    }

    let companion = load_companion();
    let buddy     = load_buddy();
    let name = coalesce(str_val(&companion, "name"), str_val(&buddy, "name"), "Vexil");

    let mut system = build_oracle_system(&sessions);
    if !activity_lines.is_empty() { system.push_str(&format!("\nRecent tool activity:\n{}\n", activity_lines.join("\n"))); }
    if !convo_lines.is_empty()    { system.push_str(&format!("Recent session conversation:\n{}\n", convo_lines.join("\n"))); }

    let mut lines = vec![system, String::new(), "--- Conversation ---".to_string()];
    for turn in &history {
        let role = if turn["role"].as_str() == Some("user") { "USER" } else { &name.to_uppercase() };
        lines.push(format!("{role}: {}", turn["content"].as_str().unwrap_or("")));
    }
    lines.push(format!("USER: {message}"));
    lines.push(format!("{}:", name.to_uppercase()));
    let full_prompt = lines.join("\n");

    let (model, timeout) = if sessions.is_empty() { ("claude-haiku-4-5-20251001", 12) } else { ("claude-sonnet-4-6", 30) };

    if let Some(reply) = call_claude(full_prompt, model, &["--bare"], timeout, &shared.sem).await {
        let entry = serde_json::json!({"type":"oracle_response","req_id":req_id,"msg":reply,"ts":now_ms()});
        append_out_raw(entry).await;
        println!("[daemon] oracle → \"{}\"", &reply[..reply.len().min(80)]);
    }
    shared.oracle_busy.store(false, Ordering::Relaxed);
}

// ── Startup check ─────────────────────────────────────────────────────────────

async fn check_claude_path() -> bool {
    match Command::new("which").arg("claude").output().await {
        Ok(o) if o.status.success() => {
            println!("[daemon] claude at: {}", String::from_utf8_lossy(&o.stdout).trim());
            true
        }
        _ => { eprintln!("[daemon] WARNING: 'claude' not on PATH — commentary disabled"); false }
    }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

pub async fn daemon_loop(shared: Arc<DaemonShared>) {
    let data_dir = expand_home("~/.local/share/pixel-terminal");
    let _ = tokio::fs::create_dir_all(&data_dir).await;
    let feed_path         = expand_home("~/.local/share/pixel-terminal/vexil_feed.jsonl");
    let oracle_query_path = expand_home("~/.local/share/pixel-terminal/oracle_query.json");

    // Startup signal (companion.js detects ⊸ online)
    append_out("\u{22b8} online").await;
    println!("[daemon] started — watching {feed_path}");

    let claude_ok = check_claude_path().await;

    loop {
        sleep(Duration::from_millis(POLL_MS)).await;

        // ── Read new feed entries (no lock held during async I/O) ─────────────
        let (offset, inode) = {
            let st = shared.state.lock().unwrap();
            (st.feed_offset, st.feed_inode)
        };
        let (new_entries, new_offset, new_inode) = read_new_lines(&feed_path, offset, inode).await;
        {
            let mut st = shared.state.lock().unwrap();
            st.feed_offset = new_offset;
            st.feed_inode  = new_inode;
        }

        // ── Oracle check (file-polling — no lock held during async I/O) ──────
        if claude_ok && !shared.oracle_busy.load(Ordering::Relaxed) {
            let last_oracle_mtime = { shared.state.lock().unwrap().oracle_mtime };
            let mtime = tokio::fs::metadata(&oracle_query_path).await.ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            if mtime > last_oracle_mtime {
                { shared.state.lock().unwrap().oracle_mtime = mtime; }
                if let Ok(content) = tokio::fs::read_to_string(&oracle_query_path).await {
                    if let Ok(query) = serde_json::from_str::<Value>(&content) {
                        // Snapshot state for oracle context (brief lock)
                        let (ra_snap, cv_snap) = {
                            let st = shared.state.lock().unwrap();
                            let ra: HashMap<String, Vec<(f64, String, String)>> = st.recent_activity.iter()
                                .map(|(k, v)| (k.clone(), v.iter().map(|(ts, t, h, _, _)| (*ts, t.clone(), h.clone())).collect()))
                                .collect();
                            let cv: HashMap<String, Vec<ConvoEntry>> = st.session_convo.iter()
                                .map(|(k, v)| (k.clone(), v.iter().cloned().collect()))
                                .collect();
                            (ra, cv)
                        };
                        shared.oracle_busy.store(true, Ordering::Relaxed);
                        let sh = shared.clone();
                        tokio::spawn(oracle_worker(query, ra_snap, cv_snap, sh));
                    }
                }
            }
        }

        if new_entries.is_empty() { continue; }

        // ── Process events ────────────────────────────────────────────────────
        let now = now_s();
        let mut tc_batch: HashMap<String, Value>    = HashMap::new();
        let mut tool_sids: HashSet<String>          = HashSet::new();

        {
            let mut st = shared.state.lock().unwrap();
            // Expire TTL-based fired_patterns
            st.fired_patterns.retain(|_, ts| now - *ts < FIRED_PATTERN_TTL_S);

            for entry in &new_entries {
                let etype = entry["type"].as_str().unwrap_or("");
                let sid   = entry["session_id"].as_str().unwrap_or("?").to_string();
                let ets   = entry["ts"].as_f64().unwrap_or(now * 1000.0) / 1000.0;

                match etype {
                    "tool_use" => {
                        let tool = entry["tool"].as_str().unwrap_or("").to_string();
                        let hint = entry["hint"].as_str().unwrap_or("").to_string();
                        if tool.is_empty() { continue; }
                        st.session_born.entry(sid.clone()).or_insert(ets);
                        let seq = st.tool_sequences.entry(sid.clone()).or_insert_with(VecDeque::new);
                        seq.push_back((ets, tool.clone(), hint.clone()));
                        if seq.len() > 20 { seq.pop_front(); }
                        let act = st.recent_activity.entry(sid.clone()).or_insert_with(VecDeque::new);
                        let file = entry["file"].as_str().map(str::to_string);
                        let cwd  = entry["cwd"].as_str().map(str::to_string);
                        act.push_back((ets, short_name(&tool), hint, file, cwd));
                        if act.len() > 6 { act.pop_front(); }
                        if classify_tool(&tool) == "write" {
                            st.fired_patterns.remove(&format!("{sid}:read_heavy"));
                        }
                        tool_sids.insert(sid);
                    }
                    "turn_complete" => {
                        if entry["tool_count"].as_u64().unwrap_or(0) > 0 {
                            tc_batch.insert(sid.clone(), entry.clone());
                        }
                        let um = entry["user_msg"].as_str().unwrap_or("").to_string();
                        let tt = entry["turn_text"].as_str().unwrap_or("").to_string();
                        if !um.is_empty() || !tt.is_empty() {
                            let cv = st.session_convo.entry(sid).or_insert_with(VecDeque::new);
                            cv.push_back((ets, um, tt));
                            if cv.len() > 4 { cv.pop_front(); }
                        }
                    }
                    "tool_any"    => { st.tools_since += 1; }
                    "tool_error"  => {
                        let tool  = entry["tool"].as_str().unwrap_or("?").to_string();
                        let error = entry["error"].as_str().unwrap_or("").to_string();
                        let key   = format!("{}:{}", tool, &error[..error.len().min(40)]);
                        let sids  = st.tool_errors.entry(key).or_default();
                        if !sids.contains(&sid) { sids.push(sid); }
                    }
                    "token_bloat" => {
                        let tok = entry["tokens"].as_u64().unwrap_or(0);
                        if tok > TOKEN_BLOAT_THRESHOLD
                            && claude_ok
                            && (now - st.last_comment_ts) > COOLDOWN_S
                            && !shared.commentary_busy.load(Ordering::Relaxed)
                        {
                            st.last_comment_ts = now;
                            let data    = serde_json::json!({"tokens": tok, "session_id": sid});
                            let persona = build_persona(&st.recent_actions);
                            shared.commentary_busy.store(true, Ordering::Relaxed);
                            let sh = shared.clone();
                            tokio::spawn(commentary_worker("token_bloat".into(), data, persona, sh));
                        }
                    }
                    _ => {}
                }
            }
        } // lock released

        if !claude_ok { continue; }
        if shared.commentary_busy.load(Ordering::Relaxed) { continue; }

        // ── Turn-complete commentary (per-session 20s cooldown) ───────────────
        for (tc_sid, tc_entry) in &tc_batch {
            let since = {
                let st = shared.state.lock().unwrap();
                now - st.last_comment_per.get(tc_sid).copied().unwrap_or(0.0)
            };
            if since < TURN_COOLDOWN_S { continue; }

            let (recent_acts, persona) = {
                let st = shared.state.lock().unwrap();
                let acts: Vec<(String, String)> = st.recent_activity.get(tc_sid)
                    .map(|a| a.iter().filter(|(ts, _, _, _, _)| now - ts <= 60.0)
                        .map(|(_, t, h, _, _)| (t.clone(), h.clone())).collect())
                    .unwrap_or_default();
                (acts, build_persona(&st.recent_actions))
            };
            if recent_acts.is_empty() { continue; }

            let act_json: Vec<Value> = recent_acts.iter().rev().take(4).rev()
                .map(|(t, h)| serde_json::json!([t, h])).collect();
            let data = serde_json::json!({
                "session_id": tc_sid,
                "tool_count": tc_entry["tool_count"],
                "activity":   act_json,
                "turn_text":  tc_entry["turn_text"],
                "user_msg":   tc_entry["user_msg"],
            });
            { let mut st = shared.state.lock().unwrap(); st.last_comment_per.insert(tc_sid.clone(), now); }
            shared.commentary_busy.store(true, Ordering::Relaxed);
            let sh = shared.clone();
            tokio::spawn(commentary_worker("turn_complete".into(), data, persona, sh));
            break; // one at a time
        }
        if shared.commentary_busy.load(Ordering::Relaxed) { continue; }

        // ── Pattern triggers (global 60s cooldown) ────────────────────────────
        let last_global = { shared.state.lock().unwrap().last_comment_ts };
        if (now - last_global) > COOLDOWN_S {
            let trigger_opt = {
                let st = shared.state.lock().unwrap();
                tool_sids.iter().find_map(|sid| {
                    check_tool_patterns(sid, &st, now).and_then(|(trigger, data)| {
                        let key = format!("{sid}:{trigger}");
                        if !st.fired_patterns.contains_key(&key) { Some((trigger, data, key)) } else { None }
                    })
                })
            };
            if let Some((trigger, data, key)) = trigger_opt {
                let persona = {
                    let mut st = shared.state.lock().unwrap();
                    st.fired_patterns.insert(key, now);
                    st.last_comment_ts = now;
                    build_persona(&st.recent_actions)
                };
                shared.commentary_busy.store(true, Ordering::Relaxed);
                let sh = shared.clone();
                tokio::spawn(commentary_worker(trigger.into(), data, persona, sh));
                continue;
            }

            // ── Activity tick ─────────────────────────────────────────────────
            let (tools_since, summary_parts, persona) = {
                let st = shared.state.lock().unwrap();
                let parts: Vec<String> = st.recent_activity.iter().filter_map(|(sid, acts)| {
                    let filtered: Vec<&ActEntry> = acts.iter()
                        .filter(|(ts, _, _, _, _)| now - ts <= ACTIVITY_RECENCY_S).collect();
                    let recent: Vec<String> = filtered.iter().rev().take(3).rev()
                        .map(|(_, t, h, _, _)| if h.is_empty() { t.clone() } else { format!("{t}({h})") })
                        .collect();
                    if recent.is_empty() { None } else { Some(format!("[{sid}] {}", recent.join(" → "))) }
                }).collect();
                (st.tools_since, parts, build_persona(&st.recent_actions))
            };

            if tools_since >= ACTIVITY_TRIGGER_CNT {
                if !summary_parts.is_empty() {
                    {
                        let mut st = shared.state.lock().unwrap();
                        st.tools_since = 0;
                        st.last_comment_ts = now;
                    }
                    let data = serde_json::json!({"summary": summary_parts.join("; ")});
                    shared.commentary_busy.store(true, Ordering::Relaxed);
                    let sh = shared.clone();
                    tokio::spawn(commentary_worker("session_activity".into(), data, persona, sh));
                    continue;
                } else {
                    let mut st = shared.state.lock().unwrap();
                    st.tools_since = 0;
                }
            }

            // ── Cross-session error ───────────────────────────────────────────
            let error_trigger = {
                let st = shared.state.lock().unwrap();
                st.tool_errors.iter()
                    .find(|(_, sids)| sids.iter().collect::<std::collections::HashSet<_>>().len() >= 2)
                    .map(|(k, sids)| (k.clone(), sids.clone()))
            };
            if let Some((key, sids)) = error_trigger {
                let persona = {
                    let mut st = shared.state.lock().unwrap();
                    st.last_comment_ts = now;
                    build_persona(&st.recent_actions)
                };
                let unique: Vec<&String> = sids.iter().collect::<std::collections::HashSet<_>>().into_iter().take(3).collect();
                let data = serde_json::json!({"key": key, "sessions": unique});
                shared.commentary_busy.store(true, Ordering::Relaxed);
                let sh = shared.clone();
                tokio::spawn(commentary_worker("cross_session_error".into(), data, persona, sh));
            }
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

pub fn start_daemon(shared: Arc<DaemonShared>) {
    tokio::spawn(daemon_loop(shared));
}
