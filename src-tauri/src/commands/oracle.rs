//! oracle.rs — Companion oracle (persistent subprocess)
//!
//! Keeps a long-lived `claude` subprocess for oracle queries, paying the ~10s
//! cold start once at spawn. Subsequent queries take ~1-2s (API round-trip only).
//! Auto-respawns if the process dies.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex as TokioMutex, Notify};

use super::daemon::{
    expand_home, now_s, load_buddy, load_companion,
    str_val, coalesce, buddy_traits, DaemonShared, ConvoEntry,
};

// ── Persistent oracle subprocess ─────────────────────────────────────────────

struct OracleProc {
    stdin:  tokio::process::ChildStdin,
    rx:     mpsc::Receiver<String>,    // receives stdout lines from reader task
    _child: Child,                      // held to keep process alive
}

pub struct OraclePool {
    proc:        TokioMutex<Option<OracleProc>>,
    ready:       Notify,
    model:       String,
    query_count: AtomicU32,
    max_queries: u32,       // 0 = no auto-respawn
    label:       &'static str,
}

impl OraclePool {
    pub fn new(model: &str, max_queries: u32, label: &'static str) -> Arc<Self> {
        Arc::new(Self {
            proc:        TokioMutex::new(None),
            ready:       Notify::new(),
            model:       model.to_string(),
            query_count: AtomicU32::new(0),
            max_queries,
            label,
        })
    }

    /// Spawn the persistent claude subprocess. Called once from daemon_loop.
    pub async fn spawn(&self) {
        if let Some(op) = self.try_spawn().await {
            *self.proc.lock().await = Some(op);
            self.query_count.store(0, Ordering::Relaxed);
            self.ready.notify_waiters();
            println!("[{}] persistent subprocess ready (model={})", self.label, self.model);
        }
    }

    async fn try_spawn(&self) -> Option<OracleProc> {
        let claude = which_claude().await?;
        let mut cmd = Command::new(&claude);
        // Behavioral-only system prompt — personality/sessions/activity injected per-query
        // in run_oracle() via [Context: ...] prefix. This avoids loading the full ~31k token
        // Claude Code default system prompt that the oracle never uses (no tools, git, or files).
        let system_prompt = "You are a companion watching Claude Code sessions. \
            Answer directly from what you know. Be opinionated and specific. \
            2 sentences max. Cut to the insight, not the description. \
            Use asterisk actions drawn from your species ethology — they add character. Keep them brief and species-authentic. \
            Users type fast with typos and shorthand. Always infer intent from context — never ask them to rephrase or clarify obvious misspellings.";
        cmd.args([
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--model", &self.model,
            "--no-session-persistence",
            "--permission-mode", "default",
            "--settings", r#"{"hooks":{}}"#,
            "--system-prompt", system_prompt,
        ]);
        cmd.stdin(std::process::Stdio::piped())
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::null());

        let mut child = match cmd.spawn() {
            Ok(c)  => c,
            Err(e) => { eprintln!("[{}] spawn error: {e}", self.label); return None; }
        };

        let stdout = child.stdout.take()?;
        let stdin  = child.stdin.take()?;

        // Background reader: drains stdout lines into a channel
        let (tx, rx) = mpsc::channel::<String>(64);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() { continue; }
                if tx.send(line).await.is_err() { break; }
            }
        });

        // Drain init events (system prompts, etc.) — don't block, just clear for 2s
        let drain_rx_ref = &rx;
        // We can't drain rx here since we're moving it. The caller will drain on first query.

        Some(OracleProc { stdin, rx, _child: child })
    }

    /// Send a query and wait for the result. Returns the reply text.
    pub async fn query(&self, prompt: &str, system_context: &str, timeout_secs: u64) -> Option<String> {
        let mut guard = self.proc.lock().await;

        // If no process, try to respawn
        if guard.is_none() {
            drop(guard);
            self.spawn().await;
            guard = self.proc.lock().await;
        }

        let op = guard.as_mut()?;

        // Build the user message with context baked in
        let content = if system_context.is_empty() {
            prompt.to_string()
        } else {
            format!("[Context: {system_context}]\n\n{prompt}")
        };

        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content }
        });
        let line = format!("{}\n", msg);

        // Write to stdin
        if op.stdin.write_all(line.as_bytes()).await.is_err() {
            eprintln!("[{}] stdin write failed — process dead, will respawn", self.label);
            *guard = None;
            return None;
        }
        if op.stdin.flush().await.is_err() {
            *guard = None;
            return None;
        }

        // Read until we get a "result" event
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let result = loop {
            match tokio::time::timeout_at(deadline, op.rx.recv()).await {
                Err(_) => {
                    eprintln!("[{}] query timeout ({timeout_secs}s)", self.label);
                    break None;
                }
                Ok(None) => {
                    eprintln!("[{}] subprocess stdout closed — will respawn", self.label);
                    *guard = None;
                    break None;
                }
                Ok(Some(line)) => {
                    if let Ok(evt) = serde_json::from_str::<Value>(&line) {
                        if evt["type"].as_str() == Some("result") {
                            let r = evt["result"].as_str().unwrap_or("").trim().to_string();
                            if r.is_empty() || r == "SKIP" {
                                eprintln!("[{}] SKIP received — no output", self.label);
                                break None;
                            }
                            break Some(r);
                        }
                    }
                }
            }
        };

        // Auto-respawn after max_queries to bound context accumulation
        if self.max_queries > 0 {
            let n = self.query_count.fetch_add(1, Ordering::Relaxed) + 1;
            if n >= self.max_queries {
                println!("[{}] respawning after {} queries (context hygiene)", self.label, n);
                *guard = None; // next query triggers fresh spawn
            }
        }

        result
    }
}

// ── TTS helpers ───────────────────────────────────────────────────────────────

/// Strip *asterisk actions* from oracle text — they're visual-only; jarring when spoken.
fn strip_for_speech(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_star = false;
    for ch in text.chars() {
        match ch {
            '*' => { in_star = !in_star; }
            _   => { if !in_star { out.push(ch); } }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Fire-and-forget TTS via macOS `say`. Kept for reference; voice.js now owns TTS via WS bridge.
#[allow(dead_code)]
fn tts_speak(text: &str) {
    let cleaned = strip_for_speech(text);
    if cleaned.is_empty() { return; }
    let buddy = super::daemon::load_buddy();
    if !buddy.get("ttsEnabled").and_then(|v| v.as_bool()).unwrap_or(true) { return; }
    let voice = buddy.get("ttsVoice").and_then(|v| v.as_str()).unwrap_or("Samantha").to_string();
    let _ = std::process::Command::new("say")
        .arg("-v").arg(&voice)
        .arg(&cleaned)
        .spawn();
}

async fn which_claude() -> Option<String> {
    match Command::new("which").arg("claude").output().await {
        Ok(o) if o.status.success() => {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            println!("[oracle] claude at: {path}");
            Some(path)
        }
        _ => { eprintln!("[oracle] WARNING: 'claude' not on PATH"); None }
    }
}

// ── Oracle system-prompt builder ──────────────────────────────────────────────

pub(crate) fn build_oracle_system(sessions: &[Value]) -> String {
    let companion = load_companion();
    let buddy     = load_buddy();
    let name = coalesce(str_val(&companion, "name"), str_val(&buddy, "name"), "Vexil");
    let species = {
        let s = str_val(&buddy, "species");
        if s.is_empty() { str_val(&companion, "species") } else { s }
    };
    let raw_personality = coalesce(str_val(&companion, "personality"), str_val(&buddy, "personality"), "");
    let (trait_line, fallback, ethology) = buddy_traits(&buddy);
    let personality = if raw_personality.is_empty() { &fallback } else { raw_personality };

    // Bones > Soul bridging: species ethology overrides personality text for physical behavior
    let bridging = if !ethology.is_empty() && !species.is_empty() {
        format!(
            "\nYour physical species is {species}. Your ethology:\n{ethology}\n\
            Your species ethology defines your mannerisms, physical actions, and how you observe. \
            If your personality text mentions a different animal, your species ethology takes \
            precedence for physical behavior and asterisk actions.\n"
        )
    } else {
        String::new()
    };

    if sessions.is_empty() {
        let mut ctx = format!("{personality}\n\n");
        if !trait_line.is_empty() { ctx.push_str(&trait_line); ctx.push('\n'); }
        ctx.push_str(&bridging);
        ctx.push_str(&format!("You are {name}. No sessions open — you're blind right now. Tell the user to press + to open a project folder. One sentence."));
        return ctx;
    }

    let sessions_str: Vec<String> = sessions.iter().map(|s| {
        format!("{} ({})", str_val(s, "name"), str_val(s, "cwd"))
    }).collect();

    let mut ctx = format!("{personality}\n\n");
    ctx.push_str(&format!("You are {name}, watching Claude Code sessions.\nOpen sessions: {}.\n", sessions_str.join("; ")));
    if !trait_line.is_empty() { ctx.push_str(&trait_line); ctx.push('\n'); }
    ctx.push_str(&bridging);
    ctx.push_str("\nAnswer directly from what you know. Be opinionated and specific. 2 sentences max. Cut to the insight, not the description.");
    ctx.push_str("\nUse asterisk actions drawn from your species ethology — they add character. Keep them brief and species-authentic.");
    ctx.push_str("\nUsers type fast with typos and shorthand. Always infer intent from context — never ask them to rephrase or clarify obvious misspellings.");
    ctx
}

// ── Core oracle call (uses persistent subprocess) ────────────────────────────

pub(crate) async fn run_oracle(
    message:  String,
    history:  Vec<Value>,
    sessions: Vec<Value>,
    ra_snap:  HashMap<String, Vec<(f64, String, String)>>,
    cv_snap:  HashMap<String, Vec<ConvoEntry>>,
    commentary_snap: Vec<(f64, String)>,
    oracle:   &Arc<OraclePool>,
) -> Option<String> {
    let now = now_s();

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

    let mut convo_lines = Vec::new();
    if let Some((_, turns)) = cv_snap.iter().max_by(|a, b| {
        let at = a.1.last().map(|e| e.0).unwrap_or(0.0);
        let bt = b.1.last().map(|e| e.0).unwrap_or(0.0);
        at.partial_cmp(&bt).unwrap_or(std::cmp::Ordering::Equal)
    }) {
        let last2: Vec<&ConvoEntry> = turns.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect();
        for (_, um, tt) in last2 {
            if !um.is_empty() { convo_lines.push(format!("USER: {}", um.chars().take(300).collect::<String>())); }
            if !tt.is_empty() { convo_lines.push(format!("CLAUDE: {}", tt.chars().take(600).collect::<String>())); }
        }
    }

    let companion = load_companion();
    let buddy     = load_buddy();
    let name = coalesce(str_val(&companion, "name"), str_val(&buddy, "name"), "Vexil");

    // Build context string (injected per-query since system prompt is fixed at spawn)
    let mut ctx = build_oracle_system(&sessions);
    if !activity_lines.is_empty() { ctx.push_str(&format!("\nRecent tool activity:\n{}\n", activity_lines.join("\n"))); }
    if !convo_lines.is_empty()    { ctx.push_str(&format!("Recent session conversation:\n{}\n", convo_lines.join("\n"))); }

    // Inject recent proactive commentary so oracle knows what "it" said in the bubble
    let recent_says: Vec<&str> = commentary_snap.iter()
        .filter(|(ts, _)| now - ts < 120.0)
        .map(|(_, msg)| msg.as_str())
        .collect();
    if !recent_says.is_empty() {
        ctx.push_str(&format!(
            "\nYou recently said these in your speech bubble (users see them and may reply):\n{}\n\
            If the user references something you said, connect it to this context.\n",
            recent_says.iter().enumerate().map(|(i, s)| format!("  {}. {}", i + 1, s)).collect::<Vec<_>>().join("\n")
        ));
    }

    // Build conversation with history
    let mut history_str = String::new();
    for turn in &history {
        let role = if turn["role"].as_str() == Some("user") { "USER" } else { &name.to_uppercase() };
        history_str.push_str(&format!("{role}: {}\n", turn["content"].as_str().unwrap_or("")));
    }

    let prompt = if history_str.is_empty() {
        message
    } else {
        format!("{history_str}USER: {message}")
    };

    oracle.query(&prompt, &ctx, 15).await
}

// ── Startup check (kept for daemon commentary path) ──────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_for_speech ──────────────────────────────────────────────────────

    #[test]
    fn strip_empty_string() {
        assert_eq!(strip_for_speech(""), "");
    }

    #[test]
    fn strip_no_asterisks_unchanged() {
        assert_eq!(strip_for_speech("Hello world"), "Hello world");
    }

    #[test]
    fn strip_single_action_removed() {
        let result = strip_for_speech("*winks* Hello");
        assert!(!result.contains("winks"), "asterisk action should be removed");
        assert!(result.contains("Hello"));
    }

    #[test]
    fn strip_action_in_middle() {
        let result = strip_for_speech("Hello *waves* world");
        assert_eq!(result, "Hello world");
    }

    #[test]
    fn strip_multiple_actions() {
        let result = strip_for_speech("*hisses* You missed it. *narrows eyes*");
        assert!(!result.contains("hisses"));
        assert!(!result.contains("narrows"));
        assert!(result.contains("You missed it."));
    }

    #[test]
    fn strip_action_only_returns_empty() {
        let result = strip_for_speech("*scales shift*");
        assert_eq!(result.trim(), "");
    }

    #[test]
    fn strip_collapses_whitespace() {
        // After removing action, multiple spaces get collapsed by split_whitespace
        let result = strip_for_speech("Hello   *waves*   world");
        assert_eq!(result, "Hello world");
    }

    // ── build_oracle_system ───────────────────────────────────────────────────

    #[test]
    fn build_oracle_system_no_sessions() {
        let result = build_oracle_system(&[]);
        assert!(!result.is_empty());
        assert!(
            result.contains("No sessions open") || result.contains("no session"),
            "no-session prompt should tell user to open a project: {result}"
        );
    }

    #[test]
    fn build_oracle_system_with_sessions_includes_names() {
        let sessions = vec![
            serde_json::json!({"name": "myproject", "cwd": "/home/user/myproject"}),
            serde_json::json!({"name": "api-server", "cwd": "/home/user/api-server"}),
        ];
        let result = build_oracle_system(&sessions);
        assert!(result.contains("myproject"), "result should include session name");
        assert!(result.contains("api-server"), "result should include second session name");
    }

    #[test]
    fn build_oracle_system_nonempty_for_any_input() {
        let empty = build_oracle_system(&[]);
        let one = build_oracle_system(&[serde_json::json!({"name": "x", "cwd": "/x"})]);
        assert!(empty.len() > 10);
        assert!(one.len() > 10);
    }
}

pub(crate) async fn check_claude_path() -> bool {
    match Command::new("which").arg("claude").output().await {
        Ok(o) if o.status.success() => {
            println!("[daemon] claude at: {}", String::from_utf8_lossy(&o.stdout).trim());
            true
        }
        _ => { eprintln!("[daemon] WARNING: 'claude' not on PATH — commentary disabled"); false }
    }
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Called directly from voice.js via invoke('oracle_query', {...}).
#[tauri::command]
pub async fn oracle_query(
    message:  String,
    history:  Vec<Value>,
    req_id:   u64,
    sessions: Vec<Value>,
    state:    tauri::State<'_, Arc<DaemonShared>>,
) -> Result<Value, String> {
    // Snapshot activity/convo/commentary without holding the lock during the claude call
    let (ra_snap, cv_snap, commentary_snap) = {
        let st = state.state.lock().map_err(|e| e.to_string())?;
        let ra: HashMap<String, Vec<(f64, String, String)>> = st.recent_activity.iter()
            .map(|(k, v)| (k.clone(), v.iter().map(|(ts, t, h, _, _)| (*ts, t.clone(), h.clone())).collect()))
            .collect();
        let cv: HashMap<String, Vec<ConvoEntry>> = st.session_convo.iter()
            .map(|(k, v)| (k.clone(), v.iter().cloned().collect()))
            .collect();
        let cm: Vec<(f64, String)> = st.recent_commentary.iter().cloned().collect();
        (ra, cv, cm)
    };

    let reply = run_oracle(message, history, sessions, ra_snap, cv_snap, commentary_snap, &state.oracle).await
        .ok_or_else(|| "oracle unreachable".to_string())?;

    println!("[oracle] query → \"{}\"", reply.chars().take(80).collect::<String>());
    // TTS is handled in voice.js playTTS() → pixel_tts_bridge.py (Qwen3-TTS).
    // The macOS `say` path here is removed to prevent double-speak.
    Ok(serde_json::json!({"msg": reply, "req_id": req_id}))
}
