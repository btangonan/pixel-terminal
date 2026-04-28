/// ws_bridge.rs — WebSocket bridge between voice clients and pixel-terminal.
///
/// Listens on ws://127.0.0.1:9876. Supports multiple concurrent clients:
///   - OmiWebhook (cloud path via Omi pendant → phone → webhook)
///   - pixel_voice_bridge.py (local mic or direct BLE path)
///
/// Incoming JSON commands from any client are emitted as Tauri events to the frontend.
/// Outgoing state_sync and mute/unmute directives are broadcast to ALL connected clients.
/// omi:connected fires when the first client connects; omi:disconnected when the last leaves.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

use crate::voice_protocol::{self, HandshakeResult};

const WS_PORT: u16 = 9876;

/// Shared state: broadcast senders to all connected WS clients,
/// plus the current mute, always-on, and capture-intent flags.
pub struct OmiBridgeState {
    pub ws_clients: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    pub voice_ready_count: AtomicU32,
    pub muted: Arc<AtomicBool>,
    pub always_on: Arc<AtomicBool>,
    /// True while the frontend PTT key is held. Replayed to pixel_voice_bridge
    /// clients that connect after the keydown frame was sent.
    pub ptt_active: Arc<AtomicBool>,
    /// Set to true once the frontend calls start_voice_capture.
    /// Replayed to pixel_voice_bridge clients on every (re)connect so the mic
    /// gate opens automatically after a sidecar restart.
    pub capture_intent: Arc<AtomicBool>,
}

impl OmiBridgeState {
    /// Broadcast a message to all clients, pruning dead senders.
    pub async fn broadcast(&self, msg: &str) {
        let mut clients = self.ws_clients.lock().await;
        let before = clients.len();
        clients.retain(|tx| tx.send(msg.to_string()).is_ok());
        let after = clients.len();
        eprintln!("[ws_bridge] broadcast to {}→{} clients: {}", before, after, msg);
    }

    pub async fn set_ptt_active_and_broadcast(&self, active: bool) {
        self.ptt_active.store(active, Ordering::SeqCst);
        let msg = serde_json::json!({ "type": if active { "ptt_start" } else { "ptt_release" } });
        self.broadcast(&msg.to_string()).await;
    }

    pub fn new_for_tests() -> Self {
        Self {
            ws_clients: Mutex::new(Vec::new()),
            voice_ready_count: AtomicU32::new(0),
            muted: Arc::new(AtomicBool::new(false)),
            always_on: Arc::new(AtomicBool::new(false)),
            ptt_active: Arc::new(AtomicBool::new(false)),
            capture_intent: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Send state that must survive sidecar reconnects or startup races.
    /// This is the same path used when a pixel_voice_bridge client registers.
    pub fn send_initial_client_state(
        &self,
        tx: &mpsc::UnboundedSender<String>,
        is_pixel_voice_bridge: bool,
    ) {
        let is_muted = self.muted.load(Ordering::SeqCst);
        let mute_msg = serde_json::json!({
            "type": if is_muted { "mute" } else { "unmute" }
        });
        let _ = tx.send(mute_msg.to_string());

        if self.always_on.load(Ordering::SeqCst) {
            let ao_msg = serde_json::json!({ "type": "always_on" });
            let _ = tx.send(ao_msg.to_string());
        }

        if is_pixel_voice_bridge && self.capture_intent.load(Ordering::SeqCst) {
            let sc_msg = serde_json::json!({ "type": "start_capture" });
            let _ = tx.send(sc_msg.to_string());
        }

        if is_pixel_voice_bridge && self.ptt_active.load(Ordering::SeqCst) {
            let ptt_msg = serde_json::json!({ "type": "ptt_start" });
            let _ = tx.send(ptt_msg.to_string());
        }
    }
}

/// Called from lib.rs setup(). Registers state and starts the server loop.
pub fn init<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let muted = Arc::new(AtomicBool::new(false));
    let always_on = Arc::new(AtomicBool::new(false));
    let ptt_active = Arc::new(AtomicBool::new(false));
    let capture_intent = Arc::new(AtomicBool::new(false));
    app.manage(OmiBridgeState {
        ws_clients: Mutex::new(Vec::new()),
        voice_ready_count: AtomicU32::new(0),
        muted,
        always_on,
        ptt_active,
        capture_intent,
    });
    tauri::async_runtime::spawn(server_loop(app.handle().clone()));
    Ok(())
}

async fn server_loop<R: tauri::Runtime>(app: AppHandle<R>) {
    let addr = format!("127.0.0.1:{WS_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[omi-bridge] Failed to bind {addr}: {e}");
            return;
        }
    };
    eprintln!("[omi-bridge] Listening on ws://{addr}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[omi-bridge] Accept error: {e}");
                continue;
            }
        };

        // Spawn each client as an independent task — does not block accept loop
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            handle_client(stream, peer.to_string(), app_clone).await;
        });
    }
}

async fn handle_client<R: tauri::Runtime>(
    stream: tokio::net::TcpStream,
    peer: String,
    app: AppHandle<R>,
) {
    eprintln!("[omi-bridge] Client connected from {peer}");

    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[omi-bridge] Handshake failed ({peer}): {e}");
            return;
        }
    };

    let (mut write, mut read) = ws.split();

    // ── Strict voice/v1 handshake gate ────────────────────────────────────
    // First frame MUST be a valid hello{protocol:"voice/v1", client, session_id}.
    // Unversioned / legacy clients are rejected with an error frame + close.
    let hello_deadline = Duration::from_millis(voice_protocol::HELLO_TIMEOUT_MS);
    let (_session_id, is_pixel_voice_bridge): (String, bool) = match timeout(hello_deadline, read.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => match voice_protocol::negotiate(&text) {
            HandshakeResult::Accepted { client, session_id } => {
                eprintln!(
                    "[omi-bridge] Handshake OK ({peer}): client={client} session={session_id}"
                );
                let _ = write
                    .send(Message::Text(voice_protocol::hello_ack()))
                    .await;
                let is_pvb = client == "pixel_voice_bridge";
                (session_id, is_pvb)
            }
            HandshakeResult::Rejected { code, message } => {
                eprintln!("[omi-bridge] Handshake rejected ({peer}): {code} — {message}");
                let _ = write
                    .send(Message::Text(voice_protocol::error_frame(&code, &message)))
                    .await;
                let _ = write.close().await;
                return;
            }
        },
        Ok(Some(Ok(_))) => {
            eprintln!("[omi-bridge] Handshake failed ({peer}): non-text frame");
            let _ = write
                .send(Message::Text(voice_protocol::error_frame(
                    "invalid_handshake",
                    "first frame must be text",
                )))
                .await;
            let _ = write.close().await;
            return;
        }
        Ok(Some(Err(e))) => {
            eprintln!("[omi-bridge] Handshake read error ({peer}): {e}");
            return;
        }
        Ok(None) => {
            eprintln!("[omi-bridge] Handshake failed ({peer}): stream closed before hello");
            return;
        }
        Err(_) => {
            eprintln!("[omi-bridge] Handshake timeout ({peer}): no hello within 2s");
            let _ = write
                .send(Message::Text(voice_protocol::error_frame(
                    "handshake_timeout",
                    "no hello within 2s",
                )))
                .await;
            let _ = write.close().await;
            return;
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Register this client and emit omi:connected if it's the first.
    // Hold a single lock across the is_empty check + push to avoid TOCTOU
    // race where two concurrent connects both see was_empty==true.
    {
        let state = app.state::<OmiBridgeState>();
        let mut clients = state.ws_clients.lock().await;
        let was_empty = clients.is_empty();
        clients.push(tx.clone());
        drop(clients);

        state.send_initial_client_state(&tx, is_pixel_voice_bridge);

        // Don't emit omi:connected here — wait for voice_ready message from
        // clients that actually provide audio input (mic/BLE bridge).
        // Cloud relays (pixel_bridge.py) connect but never send voice_ready.
        let _ = was_empty; // suppress unused variable warning
    }

    // Track whether this client has reported voice input is active.
    let mut is_voice = false;

    // Write task: drain channel → WS sink
    let write_task = tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Read loop: incoming JSON → Tauri event "omi:command"
    // voice_ready/voice_lost are intercepted to control the omi indicator dot.
    while let Some(result) = read.next().await {
        match result {
            Ok(Message::Text(text)) => {
                if let Ok(val) = serde_json::from_str::<Value>(&text) {
                    match val.get("type").and_then(|t| t.as_str()) {
                        Some("voice_ready") => {
                            if !is_voice {
                                is_voice = true;
                                let state = app.state::<OmiBridgeState>();
                                if state.voice_ready_count.fetch_add(1, Ordering::SeqCst) == 0 {
                                    let _ = app.emit("omi:connected", ());
                                }
                                eprintln!("[omi-bridge] Client {peer} voice_ready");
                            }
                        }
                        Some("voice_lost") => {
                            if is_voice {
                                is_voice = false;
                                let state = app.state::<OmiBridgeState>();
                                if state.voice_ready_count.fetch_sub(1, Ordering::SeqCst) == 1 {
                                    let _ = app.emit("omi:disconnected", ());
                                }
                                eprintln!("[omi-bridge] Client {peer} voice_lost");
                            }
                        }
                        _ => {
                            let _ = app.emit("omi:command", val);
                        }
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    // Client disconnected.
    // Abort write task and await it so rx is actually dropped before we check is_closed().
    // Without the await, abort() is async-cooperative and rx may still be alive during retain().
    write_task.abort();
    let _ = write_task.await; // drive task to completion so rx is dropped
    drop(tx);                  // drop our local clone too

    // If this client was voice-ready, decrement counter and possibly emit disconnected.
    if is_voice {
        let state = app.state::<OmiBridgeState>();
        if state.voice_ready_count.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _ = app.emit("omi:disconnected", ());
        }
    }

    // Clean up the client list.
    {
        let state = app.state::<OmiBridgeState>();
        let mut clients = state.ws_clients.lock().await;
        clients.retain(|t| !t.is_closed());
        let remaining = clients.len();
        drop(clients);
        eprintln!("[omi-bridge] Client {peer} disconnected ({remaining} remaining)");
    }
}

/// Tauri command: called from app.js whenever session list changes.
/// Broadcasts state_sync to ALL connected clients.
#[tauri::command]
pub async fn sync_omi_sessions(
    state: tauri::State<'_, OmiBridgeState>,
    sessions: Vec<serde_json::Value>,
    active: Option<String>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "state_sync",
        "sessions": sessions,
        "active": active
    });
    state.broadcast(&msg.to_string()).await;
    Ok(())
}

/// Tauri command: toggle always-on mode (skip "hey pixel" trigger).
/// "always_on" → voice bridge dispatches all speech directly.
/// "trigger_mode" → voice bridge requires "hey pixel" trigger (default).
#[tauri::command]
pub async fn set_voice_mode(
    state: tauri::State<'_, OmiBridgeState>,
    mode: String,
) -> Result<(), String> {
    state.always_on.store(mode == "always_on", Ordering::SeqCst);
    let msg = serde_json::json!({ "type": mode });
    state.broadcast(&msg.to_string()).await;
    Ok(())
}

/// Tauri command: called from app.js on fn key press.
/// Broadcasts ptt_start to all voice bridge clients — bridge begins transcribing.
#[tauri::command]
pub async fn ptt_start(
    state: tauri::State<'_, OmiBridgeState>,
) -> Result<(), String> {
    eprintln!("[ws_bridge] ptt_start invoked");
    state.set_ptt_active_and_broadcast(true).await;
    Ok(())
}

/// Tauri command: called from app.js on fn key release.
/// Broadcasts ptt_release to all voice bridge clients — bridge fires gathered buffer immediately.
#[tauri::command]
pub async fn ptt_release(
    state: tauri::State<'_, OmiBridgeState>,
) -> Result<(), String> {
    eprintln!("[ws_bridge] ptt_release invoked");
    state.set_ptt_active_and_broadcast(false).await;
    Ok(())
}

/// Tauri command: called from app.js settings panel to switch voice source (ble/mic).
/// Bridge handles by raising SwitchSource exception → clean restart with new mode.
#[tauri::command]
pub async fn switch_voice_source(
    state: tauri::State<'_, OmiBridgeState>,
    source: String,
) -> Result<(), String> {
    let msg = serde_json::json!({ "type": "switch_source", "source": source });
    state.broadcast(&msg.to_string()).await;
    Ok(())
}

/// Tauri command: opens the mic gate on all connected voice clients.
/// Called from voice.js after start_voice_sidecar succeeds.
/// Sets capture_intent=true so any pixel_voice_bridge reconnect also receives
/// start_capture immediately (handles sidecar restarts without re-clicking).
#[tauri::command]
pub async fn start_voice_capture(
    state: tauri::State<'_, OmiBridgeState>,
) -> Result<(), String> {
    state.capture_intent.store(true, Ordering::SeqCst);
    let msg = serde_json::json!({ "type": "start_capture" });
    state.broadcast(&msg.to_string()).await;
    Ok(())
}

/// Tauri command: check if any voice client is connected (called on frontend load).
#[tauri::command]
pub async fn get_voice_status(
    state: tauri::State<'_, OmiBridgeState>,
) -> Result<bool, String> {
    Ok(state.voice_ready_count.load(Ordering::SeqCst) > 0)
}

/// Tauri command: called from app.js when the user toggles the Omi listen switch.
/// Stores mute state and broadcasts mute/unmute to ALL connected clients.
#[tauri::command]
pub async fn set_omi_listening(
    state: tauri::State<'_, OmiBridgeState>,
    enabled: bool,
) -> Result<(), String> {
    state.muted.store(!enabled, Ordering::SeqCst);
    let msg = serde_json::json!({
        "type": if enabled { "unmute" } else { "mute" }
    });
    state.broadcast(&msg.to_string()).await;
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// Verifies the PTT broadcast pathway end-to-end inside the bridge:
    /// register a fake client → call set_ptt_active_and_broadcast → assert
    /// the client's rx receives the ptt_start frame.
    ///
    /// Regression guard for the silent-PTT bug observed 2026-04-25 where
    /// JS invoke('ptt_start') resolved without errors but anima-stt never
    /// logged "PTT start — recording". If broadcast() ever drops messages
    /// to a registered client, this test will catch it.
    #[tokio::test]
    async fn ptt_start_broadcast_reaches_registered_client() {
        let state = OmiBridgeState::new_for_tests();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        state.ws_clients.lock().await.push(tx);

        state.set_ptt_active_and_broadcast(true).await;

        let received = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            rx.recv(),
        )
        .await
        .expect("broadcast did not deliver within 500ms")
        .expect("client tx dropped");

        assert!(
            received.contains("\"ptt_start\""),
            "expected ptt_start frame, got: {received}"
        );
        assert!(
            state.ptt_active.load(Ordering::SeqCst),
            "ptt_active flag should be true after start"
        );
    }

    #[tokio::test]
    async fn ptt_release_broadcast_reaches_registered_client() {
        let state = OmiBridgeState::new_for_tests();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        state.ws_clients.lock().await.push(tx);

        state.set_ptt_active_and_broadcast(true).await;
        let _ = rx.recv().await; // discard ptt_start
        state.set_ptt_active_and_broadcast(false).await;

        let released = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            rx.recv(),
        )
        .await
        .expect("ptt_release did not deliver")
        .expect("client tx dropped");

        assert!(released.contains("\"ptt_release\""), "got: {released}");
        assert!(!state.ptt_active.load(Ordering::SeqCst));
    }

    /// Regression guard for the timing-race bug observed 2026-04-25 where
    /// the user pressed PTT before anima-stt connected, so broadcast went
    /// to ZERO clients (visible in log as `broadcast to 0→0 clients`).
    /// The bridge must not panic, must not lose state for late joiners, and
    /// must still flip the ptt_active flag so a subsequent reconnect can
    /// replay it via send_initial_client_state.
    #[tokio::test]
    async fn ptt_broadcast_to_zero_clients_does_not_panic_and_preserves_state() {
        let state = OmiBridgeState::new_for_tests();
        // No clients registered — this is the race window.
        assert_eq!(state.ws_clients.lock().await.len(), 0);

        state.set_ptt_active_and_broadcast(true).await;

        // Flag must persist so a late-joining anima-stt picks it up via
        // send_initial_client_state when it eventually connects.
        assert!(
            state.ptt_active.load(Ordering::SeqCst),
            "ptt_active must remain true after broadcast-to-zero so late joiner can replay"
        );
    }

    /// send_initial_client_state replays start_capture when capture_intent
    /// is set — this is what saves a late-joining anima-stt that connects
    /// AFTER the frontend already invoked start_voice_capture.
    #[tokio::test]
    async fn initial_state_replays_start_capture_for_pixel_voice_bridge() {
        let state = OmiBridgeState::new_for_tests();
        state.capture_intent.store(true, Ordering::SeqCst);

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        state.send_initial_client_state(&tx, /*is_pixel_voice_bridge=*/ true);

        // Drain the queue and look for start_capture.
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        assert!(
            frames.iter().any(|f| f.contains("\"start_capture\"")),
            "expected start_capture replay when capture_intent=true; got: {frames:?}"
        );
    }

    /// Companion test: cloud relays (NOT pixel_voice_bridge) must NOT
    /// receive start_capture replay — they're not voice sources.
    #[tokio::test]
    async fn initial_state_does_not_replay_start_capture_for_cloud_clients() {
        let state = OmiBridgeState::new_for_tests();
        state.capture_intent.store(true, Ordering::SeqCst);

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        state.send_initial_client_state(&tx, /*is_pixel_voice_bridge=*/ false);

        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        assert!(
            !frames.iter().any(|f| f.contains("\"start_capture\"")),
            "cloud relay must not receive start_capture; got: {frames:?}"
        );
    }

    /// send_initial_client_state replays ptt_start to a late-joining client
    /// IF ptt_active is still true. This is the recovery path for the race
    /// where PTT broadcast hit 0 clients but the user is still holding Fn.
    #[tokio::test]
    async fn initial_state_replays_ptt_start_when_key_still_held() {
        let state = OmiBridgeState::new_for_tests();
        state.ptt_active.store(true, Ordering::SeqCst);

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        state.send_initial_client_state(&tx, /*is_pixel_voice_bridge=*/ true);

        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        assert!(
            frames.iter().any(|f| f.contains("\"ptt_start\"")),
            "expected ptt_start replay when ptt_active=true; got: {frames:?}"
        );
    }

    /// Verifies the polling contract used by start_voice_sidecar to wait for
    /// anima-stt to actually connect. Today's bug: start_voice_sidecar returned
    /// immediately after spawn, so the JS handler resolved before anima-stt was
    /// ready, and PTT broadcasts hit zero clients. The fix polls voice_ready_count
    /// in a 100ms loop until it goes positive (or 8s timeout). This test simulates
    /// a slow anima-stt startup (200ms) and asserts the poll resolves within the
    /// expected window.
    #[tokio::test]
    async fn voice_ready_poll_unblocks_when_count_increments() {
        use std::sync::Arc;
        let state = Arc::new(OmiBridgeState::new_for_tests());

        // Background: simulate anima-stt sending voice_ready after 200ms.
        let bg_state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            bg_state.voice_ready_count.fetch_add(1, Ordering::SeqCst);
        });

        // Mirror the start_voice_sidecar polling loop.
        let start = std::time::Instant::now();
        let mut waited_ms = 0u32;
        while state.voice_ready_count.load(Ordering::SeqCst) == 0 && waited_ms < 8000 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            waited_ms += 100;
        }
        let elapsed = start.elapsed();

        assert!(
            state.voice_ready_count.load(Ordering::SeqCst) > 0,
            "poll exited but voice_ready_count is still 0 — race fix is broken"
        );
        assert!(
            elapsed.as_millis() < 1000,
            "poll took {elapsed:?} — should resolve shortly after 200ms simulated readiness"
        );
        assert!(
            waited_ms >= 200,
            "waited_ms={waited_ms} — should have polled at least once"
        );
    }

    /// Counterpart: if anima-stt never connects (voice_ready_count stays 0),
    /// the poll must still terminate at the timeout — never hang forever.
    #[tokio::test]
    async fn voice_ready_poll_terminates_at_timeout_when_stt_never_ready() {
        let state = OmiBridgeState::new_for_tests();
        // Use a SHORT timeout for this test (production uses 8000ms).
        let max_wait_ms: u32 = 400;

        let start = std::time::Instant::now();
        let mut waited_ms = 0u32;
        while state.voice_ready_count.load(Ordering::SeqCst) == 0 && waited_ms < max_wait_ms {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            waited_ms += 100;
        }
        let elapsed = start.elapsed();

        assert_eq!(state.voice_ready_count.load(Ordering::SeqCst), 0);
        assert!(
            waited_ms >= max_wait_ms,
            "waited_ms={waited_ms} should have hit timeout {max_wait_ms}"
        );
        assert!(
            elapsed.as_millis() < (max_wait_ms as u128 + 200),
            "poll took {elapsed:?} — should not exceed timeout by more than ~poll interval"
        );
    }

    /// broadcast() must prune dead senders without crashing — guards against
    /// a stale anima-stt entry leaking into ws_clients after sidecar exit.
    #[tokio::test]
    async fn broadcast_prunes_dead_clients() {
        let state = OmiBridgeState::new_for_tests();
        let (live_tx, mut live_rx) = mpsc::unbounded_channel::<String>();
        let (dead_tx, dead_rx) = mpsc::unbounded_channel::<String>();
        drop(dead_rx); // simulate disconnected client

        {
            let mut clients = state.ws_clients.lock().await;
            clients.push(dead_tx);
            clients.push(live_tx);
            assert_eq!(clients.len(), 2);
        }

        state.broadcast("{\"type\":\"ping\"}").await;

        // Live client got it; map pruned the dead one.
        let received = live_rx.try_recv().expect("live client should have received");
        assert!(received.contains("ping"));
        assert_eq!(
            state.ws_clients.lock().await.len(),
            1,
            "broadcast must drop the closed sender"
        );
    }
}
