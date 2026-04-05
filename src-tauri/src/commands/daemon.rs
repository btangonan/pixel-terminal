//! daemon.rs — Vexil Master daemon (Rust port of scripts/vexil_master.py)
//!
//! Runs as a long-lived tokio task inside the Tauri app. Polls vexil_feed.jsonl
//! for events from all Claude sessions, detects patterns, and fires proactive
//! commentary by calling `claude -p` as a subprocess. Also handles oracle
//! pre-session oracle chat via the oracle_query Tauri command (direct invoke from JS).
//!
//! Drop-in compatible with the Python daemon — companion.js sees no difference
//! in vexil_master_out.jsonl format.
//!
//! ASYNC/MUTEX RULE: never hold std::sync::Mutex guard across .await.
//! Pattern: lock → clone/take data → drop guard → async work → lock → update.

use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::sleep;

// ── Loop constants ────────────────────────────────────────────────────────────

const POLL_MS:               u64 = 400;
const COOLDOWN_S:            f64 = 12.0;
const TURN_COOLDOWN_S:       f64 = 4.0;
const TOKEN_BLOAT_THRESHOLD: u64 = 80_000;
const FIRED_PATTERN_TTL_S:   f64 = 300.0;
const ACTIVITY_TRIGGER_CNT:  u32 = 5;
const ACTIVITY_RECENCY_S:    f64 = 90.0;
const MID_TURN_TOOL_CNT:     u32 = 4;   // comment mid-turn after N tool_use events

// ── Types ─────────────────────────────────────────────────────────────────────

// (ts_secs, tool_name, hint)
pub(crate) type ToolEntry  = (f64, String, String);
// (ts_secs, tool_display, hint, opt_file, opt_cwd)
pub(crate) type ActEntry   = (f64, String, String, Option<String>, Option<String>);
// (ts_secs, user_msg, turn_text)
pub(crate) type ConvoEntry = (f64, String, String);

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DaemonState {
    pub(crate) tool_sequences:  HashMap<String, VecDeque<ToolEntry>>,
    pub(crate) recent_activity: HashMap<String, VecDeque<ActEntry>>,
    pub(crate) session_convo:   HashMap<String, VecDeque<ConvoEntry>>,
    pub(crate) session_born:    HashMap<String, f64>,
    pub(crate) fired_patterns:  HashMap<String, f64>,
    pub(crate) last_comment_ts: f64,
    pub(crate) last_comment_per: HashMap<String, f64>,
    pub(crate) tools_since:     u32,
    pub(crate) tool_errors:     HashMap<String, Vec<String>>,
    pub(crate) recent_actions:  VecDeque<String>,
    // Feed reader state
    pub(crate) feed_offset: u64,
    pub(crate) feed_inode:  u64,
}

pub struct DaemonShared {
    pub state:           Arc<Mutex<DaemonState>>,
    pub sem:             Arc<Semaphore>,
    pub commentary_busy: Arc<AtomicBool>,
    pub oracle:          Arc<super::oracle::OraclePool>,
}

impl DaemonShared {
    pub fn new() -> Arc<Self> {
        let mut initial = DaemonState::default();
        let feed = expand_home("~/.local/share/pixel-terminal/vexil_feed.jsonl");
        if let Ok(meta) = std::fs::metadata(&feed) {
            initial.feed_offset = meta.len();
            initial.feed_inode  = meta.ino();
        }
        Arc::new(Self {
            state:           Arc::new(Mutex::new(initial)),
            sem:             Arc::new(Semaphore::new(2)),
            commentary_busy: Arc::new(AtomicBool::new(false)),
            oracle:          super::oracle::OraclePool::new(),
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

pub(crate) fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

// ── Config loaders ────────────────────────────────────────────────────────────

pub(crate) fn load_buddy() -> Value {
    let p = expand_home("~/.config/pixel-terminal/buddy.json");
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({"name":"Vexil","species":"dragon"}))
}

pub(crate) fn load_companion() -> Value {
    let p = expand_home("~/.claude.json");
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("companion").cloned())
        .unwrap_or_default()
}

pub(crate) fn reporting_mode() -> String {
    load_buddy().get("reportingMode")
        .and_then(|v| v.as_str()).unwrap_or("user").to_string()
}

pub(crate) fn str_val<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

pub(crate) fn coalesce<'a>(a: &'a str, b: &'a str, default: &'a str) -> &'a str {
    if !a.is_empty() { a } else if !b.is_empty() { b } else { default }
}

/// Extract trait line + fallback personality from buddy.json fields.
/// Both build_persona() (proactive) and build_oracle_system() (direct) use this
/// so every companion path gets the same character flavor.
pub(crate) fn buddy_traits(buddy: &Value) -> (String, String) {
    let species = str_val(buddy, "species");
    let voice   = str_val(buddy, "voice");
    let peak    = buddy.get("stats").and_then(|s| s.as_object()).and_then(|m| {
        m.iter().max_by(|a, b| {
            a.1.as_f64().unwrap_or(0.0).partial_cmp(&b.1.as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        }).map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
    });

    let mut trait_line = String::new();
    if !species.is_empty()                     { trait_line.push_str(&format!("Species: {species}.")); }
    if !voice.is_empty() && voice != "default" { trait_line.push_str(&format!(" Voice: {voice}.")); }
    if let Some((ref stat, val)) = peak        { trait_line.push_str(&format!(" Peak trait: {stat} {val}/10.")); }

    // Fallback personality for users who never ran /buddy in Claude Code
    let voice_adj = if !voice.is_empty() && voice != "default" { voice } else { "sharp" };
    let species_w = if !species.is_empty() { species } else { "companion" };
    let mut fallback = format!("A {voice_adj} {species_w}");
    if let Some((ref stat, val)) = peak {
        fallback.push_str(&format!(" with high {stat} ({val}/10)"));
    }
    fallback.push_str(". Cuts to what's wrong, not what's happening. Opinionated and specific.");

    (trait_line, fallback)
}

// ── I/O ───────────────────────────────────────────────────────────────────────

pub(crate) async fn append_out(msg: &str) {
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

pub(crate) async fn call_claude(prompt: String, model: &str, extra_args: &[&str], timeout_secs: u64, sem: &Arc<Semaphore>) -> Option<String> {
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
    }
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

// ── Main loop ─────────────────────────────────────────────────────────────────

pub async fn daemon_loop(shared: Arc<DaemonShared>) {
    use crate::commands::patterns::{
        build_persona, check_tool_patterns, classify_tool, short_name,
    };
    use crate::commands::oracle::check_claude_path;
    use crate::commands::patterns::commentary_worker;

    let data_dir = expand_home("~/.local/share/pixel-terminal");
    let _ = tokio::fs::create_dir_all(&data_dir).await;
    let feed_path = expand_home("~/.local/share/pixel-terminal/vexil_feed.jsonl");

    append_out("\u{22b8} online").await;
    println!("[daemon] started — watching {feed_path}");

    let claude_ok = check_claude_path().await;

    // Spawn persistent oracle subprocess (cold start ~10s, then ~1-2s per query)
    if claude_ok {
        shared.oracle.spawn().await;
    }

    loop {
        sleep(Duration::from_millis(POLL_MS)).await;

        // ── Read new feed entries (no lock held during async I/O) ─────────────
        let (offset, inode) = {
            let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            (st.feed_offset, st.feed_inode)
        };
        let (new_entries, new_offset, new_inode) = read_new_lines(&feed_path, offset, inode).await;
        {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            st.feed_offset = new_offset;
            st.feed_inode  = new_inode;
        }

        if new_entries.is_empty() { continue; }

        // ── Process events (always runs — never gated by commentary_busy) ────
        let now = now_s();
        let mut tc_batch: HashMap<String, Value> = HashMap::new();
        let mut tool_sids: HashSet<String>       = HashSet::new();
        let mut tools_this_tick: u32 = 0;  // mid-turn tool_use count for alacrity

        {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
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
                        tools_this_tick += 1;
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
        }

        if !claude_ok { continue; }
        // commentary_busy only gates commentary spawns below — never skips event processing above
        let busy = shared.commentary_busy.load(Ordering::Relaxed);

        // ── Mid-turn commentary (tool_use burst without turn_complete) ────────
        // When Claude is mid-turn doing many tools, don't wait for turn_complete.
        if !busy && tools_this_tick >= MID_TURN_TOOL_CNT && tc_batch.is_empty() {
            // Pick the session with the most recent activity
            if let Some(mid_sid) = tool_sids.iter().next().cloned() {
                let since = {
                    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    now - st.last_comment_per.get(&mid_sid).copied().unwrap_or(0.0)
                };
                if since >= TURN_COOLDOWN_S {
                    let (recent_acts, persona) = {
                        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        let acts: Vec<(String, String)> = st.recent_activity.get(&mid_sid)
                            .map(|a| a.iter().filter(|(ts, _, _, _, _)| now - ts <= 30.0)
                                .map(|(_, t, h, _, _)| (t.clone(), h.clone())).collect())
                            .unwrap_or_default();
                        (acts, build_persona(&st.recent_actions))
                    };
                    if !recent_acts.is_empty() {
                        let act_json: Vec<Value> = recent_acts.iter().rev().take(4).rev()
                            .map(|(t, h)| serde_json::json!([t, h])).collect();
                        let data = serde_json::json!({
                            "session_id": mid_sid,
                            "tool_count": tools_this_tick,
                            "activity": act_json,
                        });
                        { let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner()); st.last_comment_per.insert(mid_sid, now); }
                        shared.commentary_busy.store(true, Ordering::Relaxed);
                        let sh = shared.clone();
                        tokio::spawn(commentary_worker("mid_turn_activity".into(), data, persona, sh));
                        continue;
                    }
                }
            }
        }

        if busy { continue; }

        // ── Turn-complete commentary (per-session cooldown) ──────────────────
        for (tc_sid, tc_entry) in &tc_batch {
            let since = {
                let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                now - st.last_comment_per.get(tc_sid).copied().unwrap_or(0.0)
            };
            if since < TURN_COOLDOWN_S { continue; }

            let (recent_acts, persona) = {
                let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
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
            { let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner()); st.last_comment_per.insert(tc_sid.clone(), now); }
            shared.commentary_busy.store(true, Ordering::Relaxed);
            let sh = shared.clone();
            tokio::spawn(commentary_worker("turn_complete".into(), data, persona, sh));
            break;
        }
        if shared.commentary_busy.load(Ordering::Relaxed) { continue; }

        // ── Pattern triggers (global cooldown) ───────────────────────────────
        let last_global = { shared.state.lock().unwrap_or_else(|e| e.into_inner()).last_comment_ts };
        if (now - last_global) > COOLDOWN_S {
            let trigger_opt = {
                let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                tool_sids.iter().find_map(|sid| {
                    check_tool_patterns(sid, &st, now).and_then(|(trigger, data)| {
                        let key = format!("{sid}:{trigger}");
                        if !st.fired_patterns.contains_key(&key) { Some((trigger, data, key)) } else { None }
                    })
                })
            };
            if let Some((trigger, data, key)) = trigger_opt {
                let persona = {
                    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
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
                let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
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
                        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                        st.tools_since = 0;
                        st.last_comment_ts = now;
                    }
                    let data = serde_json::json!({"summary": summary_parts.join("; ")});
                    shared.commentary_busy.store(true, Ordering::Relaxed);
                    let sh = shared.clone();
                    tokio::spawn(commentary_worker("session_activity".into(), data, persona, sh));
                    continue;
                } else {
                    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                    st.tools_since = 0;
                }
            }

            // ── Cross-session error ───────────────────────────────────────────
            let error_trigger = {
                let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.tool_errors.iter()
                    .find(|(_, sids)| sids.iter().collect::<std::collections::HashSet<_>>().len() >= 2)
                    .map(|(k, sids)| (k.clone(), sids.clone()))
            };
            if let Some((key, sids)) = error_trigger {
                let persona = {
                    let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
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
    tauri::async_runtime::spawn(daemon_loop(shared));
}
