//! patterns.rs — Tool-pattern detection and proactive commentary
//!
//! Detects retry loops, read-heavy phases, and other patterns in Claude's
//! tool usage. Fires commentary via the companion speech bubble.

use std::collections::VecDeque;
use std::sync::Arc;
use serde_json::Value;

use super::daemon::{
    call_claude, append_out, reporting_mode, now_s,
    load_buddy, load_companion, str_val, coalesce, buddy_traits,
    DaemonShared, DaemonState, ToolEntry,
};

// ── Pattern detection constants ───────────────────────────────────────────────

pub(crate) const RETRY_THRESHOLD:        usize = 3;
pub(crate) const READ_HEAVY_THRESHOLD:   usize = 5;
pub(crate) const READ_HEAVY_MIN_READS:   usize = 4;
pub(crate) const READ_HEAVY_WINDOW_S:    f64   = 90.0;
pub(crate) const ORIENTATION_SUPPRESS_S: f64   = 120.0;

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

// ── Tool classification helpers ───────────────────────────────────────────────

pub(crate) fn classify_tool(name: &str) -> &'static str {
    if WRITE_TOOLS.iter().any(|w| name.starts_with(w)) { return "write"; }
    let bare = if name.contains("__") { name.split("__").last().unwrap_or(name) } else { name };
    if READ_TOOLS.iter().any(|r| bare == *r || name == *r) { return "read"; }
    "other"
}

pub(crate) fn short_name(tool: &str) -> String {
    tool.replace("mcp__", "").replace("__", " ").replace('_', " ")
}

fn is_internal(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    INTERNAL_TERMS.iter().any(|t| lower.contains(&t.to_lowercase()))
}

// ── Persona builder ───────────────────────────────────────────────────────────

pub(crate) fn build_persona(recent_actions: &VecDeque<String>) -> String {
    let companion = load_companion();
    let buddy     = load_buddy();
    let name = coalesce(str_val(&companion, "name"), str_val(&buddy, "name"), "Vexil");
    let raw_personality = coalesce(str_val(&companion, "personality"), str_val(&buddy, "personality"), "");
    let (trait_line, fallback) = buddy_traits(&buddy);
    let personality = if raw_personality.is_empty() { &fallback } else { raw_personality };

    let mut p = format!(
        "{personality}\n\n"
    );
    if !trait_line.is_empty() { p.push_str(&trait_line); p.push('\n'); }
    p.push_str(&format!(
        "You watch across multiple Claude Code sessions and occasionally drop one line \
        in a speech bubble. You're not {name} — you're writing its line.\n\
        One physical action in asterisks, specific to this moment — never repeat the same action twice in a row.\n\
        Under 20 words total. Say what's wrong, not what's happening. No preamble."
    ));
    if !recent_actions.is_empty() {
        let list: Vec<&str> = recent_actions.iter().map(|s| s.as_str()).collect();
        p.push_str(&format!("\nDo NOT use these recent actions: {}.", list.join(", ")));
    }
    p
}

// ── Pattern detection ─────────────────────────────────────────────────────────

pub(crate) fn check_tool_patterns(sid: &str, st: &DaemonState, now: f64) -> Option<(&'static str, Value)> {
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

pub(crate) fn build_prompt(trigger: &str, data: &Value) -> Option<String> {
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
        "mid_turn_activity" => {
            let tc   = data["tool_count"].as_u64().unwrap_or(0);
            let acts: Vec<String> = data["activity"].as_array().map(|a| a.iter().map(|e| {
                let t = e[0].as_str().unwrap_or(""); let h = e[1].as_str().unwrap_or("");
                if h.is_empty() { t.into() } else { format!("{t}({h})") }
            }).collect()).unwrap_or_default();
            let steps = acts.join(" → ");
            Some(format!(
                "Mid-turn: {steps} ({tc} tools so far, still going).\n\n\
                Write the next line for the companion. React to what Claude is doing RIGHT NOW — \
                the direction, pace, or intent behind the current burst. Under 20 words. \
                If nothing genuinely additive, output exactly: SKIP"
            ))
        }
        _ => None,
    }
}

// ── Commentary worker (spawned as tokio task) ─────────────────────────────────

pub(crate) async fn commentary_worker(trigger: String, data: Value, persona: String, shared: Arc<DaemonShared>) {
    let Some(body) = build_prompt(&trigger, &data) else {
        shared.commentary_busy.store(false, std::sync::atomic::Ordering::Relaxed);
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
    shared.commentary_busy.store(false, std::sync::atomic::Ordering::Relaxed);
}
