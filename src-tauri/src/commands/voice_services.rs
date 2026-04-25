use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tokio::{net::TcpStream, sync::mpsc, time::{sleep, timeout}};

const STT_PORT: u16 = 9876;
const TTS_PORT: u16 = 9877;
const MAX_RESTARTS: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum VoiceServiceKind {
    Stt,
    Tts,
}

impl VoiceServiceKind {
    fn sidecar_name(self) -> &'static str {
        match self {
            Self::Stt => "anima-stt",
            Self::Tts => "anima-tts",
        }
    }
    fn port(self) -> u16 {
        match self {
            Self::Stt => STT_PORT,
            Self::Tts => TTS_PORT,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Stt => "stt",
            Self::Tts => "tts",
        }
    }
}

// std::sync::Mutex — never held across await points.
#[derive(Default)]
pub struct VoiceServicesState {
    data: Mutex<VoiceData>,
}

#[derive(Default)]
struct VoiceData {
    children: HashMap<VoiceServiceKind, CommandChild>,
    restart_counts: HashMap<VoiceServiceKind, u8>,
    // Bug 2+4 fix: sentinel consumed by monitor to skip restart on deliberate kill.
    intentional_stops: HashSet<VoiceServiceKind>,
    // Bug 4 fix: monotonic per-service counter; stale monitors/messages are ignored.
    generations: HashMap<VoiceServiceKind, u64>,
    // Bug 5 fix: initial args preserved so crash restart restores --ble.
    last_args: HashMap<VoiceServiceKind, Vec<String>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct VoiceServiceStatus {
    pub stt_running: bool,
    pub tts_running: bool,
    pub stt_port_open: bool,
    pub tts_port_open: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
struct VoiceServiceEvent {
    service: &'static str,
    port: u16,
    reason: Option<String>,
}

async fn port_open(port: u16) -> bool {
    timeout(
        Duration::from_millis(300),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// Kill one service intentionally (used for partial-start cleanup and explicit stop).
/// Bumps generation so any in-flight monitor for this kind is invalidated.
fn stop_kind(state: &Arc<VoiceServicesState>, kind: VoiceServiceKind) {
    let child = {
        let mut data = state.data.lock().unwrap();
        data.intentional_stops.insert(kind);
        let next_gen = data.generations.get(&kind).copied().unwrap_or(0).wrapping_add(1);
        data.generations.insert(kind, next_gen);
        data.restart_counts.remove(&kind);
        data.last_args.remove(&kind);
        data.children.remove(&kind)
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
}

/// Spawn one sidecar binary (sync). Restart signals travel via channel to avoid
/// recursive async calls. `generation` ties this monitor to the current lifecycle epoch.
fn spawn_child<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<VoiceServicesState>,
    kind: VoiceServiceKind,
    args: Vec<String>,
    generation: u64,
    restart_tx: mpsc::UnboundedSender<(VoiceServiceKind, u64, Vec<String>)>,
) -> Result<(), String> {
    let shell = app.shell();
    let mut command = shell
        .sidecar(kind.sidecar_name())
        .map_err(|e| e.to_string())?
        .args(args.clone());

    command = match kind {
        VoiceServiceKind::Stt => command
            .env("VOICE_STT_BACKEND", "moonshine")
            .env("VOICE_BARGEIN_ENABLED", "0")
            .env("PYTHONUNBUFFERED", "1"),
        VoiceServiceKind::Tts => command
            .env("TTS_BACKEND", "qwen3_mlx")
            .env("PYTHONUNBUFFERED", "1"),
    };

    let (mut rx, child) = command.spawn().map_err(|e| {
        let message = e.to_string();
        let event_name = if message.to_lowercase().contains("permission") {
            "voice:permission_denied"
        } else {
            "voice:crashed"
        };
        let _ = app.emit(
            event_name,
            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some(message.clone()) },
        );
        message
    })?;

    state.data.lock().unwrap().children.insert(kind, child);

    let _ = app.emit(
        "voice:started",
        VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: None },
    );

    let app2 = app.clone();
    let state2 = state.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(term) => {
                    let (should_restart, intentional, restart_args) = {
                        let mut data = state2.data.lock().unwrap();
                        data.children.remove(&kind);

                        // Stale monitor — a newer lifecycle epoch owns this service now.
                        if data.generations.get(&kind).copied() != Some(generation) {
                            (false, false, None)
                        } else if data.intentional_stops.remove(&kind) {
                            // Deliberate stop — clean up and signal stopped.
                            data.restart_counts.remove(&kind);
                            data.last_args.remove(&kind);
                            (false, true, None)
                        } else {
                            // Unexpected crash — restart up to MAX_RESTARTS.
                            let count = data.restart_counts.entry(kind).or_insert(0);
                            let ok = *count < MAX_RESTARTS;
                            if ok { *count += 1; }
                            // Bug 5 fix: use stored args to preserve --ble.
                            let restart_args = if ok {
                                data.last_args.get(&kind).cloned().or_else(|| Some(args.clone()))
                            } else {
                                None
                            };
                            (ok, false, restart_args)
                        }
                    };

                    if intentional {
                        let _ = app2.emit(
                            "voice:stopped",
                            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("stopped by user".into()) },
                        );
                        break;
                    }

                    let _ = app2.emit(
                        "voice:crashed",
                        VoiceServiceEvent {
                            service: kind.label(),
                            port: kind.port(),
                            reason: Some(format!("terminated code={:?} signal={:?}", term.code, term.signal)),
                        },
                    );

                    if let Some(restart_args) = restart_args {
                        sleep(Duration::from_secs(1)).await;
                        // Re-check generation after sleep — a stop/restart may have fired.
                        let still_current = state2.data.lock().unwrap()
                            .generations.get(&kind).copied() == Some(generation);
                        if still_current {
                            let _ = restart_tx.send((kind, generation, restart_args));
                        }
                    }
                    break;
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    if text.to_lowercase().contains("permission") {
                        let _ = app2.emit(
                            "voice:permission_denied",
                            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some(text.to_string()) },
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Restart-coordinator loop. Rejects stale generation messages so old monitors
/// cannot spawn obsolete processes after a stop/restart.
fn start_restart_loop<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: Arc<VoiceServicesState>,
    mut restart_rx: mpsc::UnboundedReceiver<(VoiceServiceKind, u64, Vec<String>)>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some((kind, generation, args)) = restart_rx.recv().await {
            // Bug 4 fix: discard stale restart messages.
            let is_current = state.data.lock().unwrap()
                .generations.get(&kind).copied() == Some(generation);
            if !is_current {
                continue;
            }

            // Bug 1 fix: only TTS owns a port; STT connects to ws_bridge on 9876.
            if kind == VoiceServiceKind::Tts && port_open(kind.port()).await {
                let _ = app.emit(
                    "voice:port_unavailable",
                    VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("port in use during restart".into()) },
                );
                continue;
            }

            let (new_tx, new_rx) = mpsc::unbounded_channel();
            start_restart_loop(app.clone(), state.clone(), new_rx);
            if let Err(e) = spawn_child(&app, &state, kind, args, generation, new_tx) {
                let _ = app.emit(
                    "voice:crashed",
                    VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some(e) },
                );
            }
        }
    });
}

/// Bug 1 fix: only check port for TTS (it binds 9877). STT is a client of
/// ws_bridge on 9876 — checking that port would always block valid STT startup.
async fn start_one<R: Runtime + 'static>(
    app: &AppHandle<R>,
    state: &Arc<VoiceServicesState>,
    kind: VoiceServiceKind,
    args: Vec<String>,
) -> Result<(), String> {
    if kind == VoiceServiceKind::Tts && port_open(kind.port()).await {
        let _ = app.emit(
            "voice:port_unavailable",
            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("port already in use".into()) },
        );
        return Err(format!("tts port {} is already in use", kind.port()));
    }

    let generation = {
        let mut data = state.data.lock().unwrap();
        data.intentional_stops.remove(&kind);
        let next_gen = data.generations.get(&kind).copied().unwrap_or(0).wrapping_add(1);
        data.generations.insert(kind, next_gen);
        data.restart_counts.insert(kind, 0);
        data.last_args.insert(kind, args.clone());
        next_gen
    };

    let (restart_tx, restart_rx) = mpsc::unbounded_channel();
    start_restart_loop(app.clone(), state.clone(), restart_rx);
    spawn_child(app, state, kind, args, generation, restart_tx)
}

#[tauri::command]
pub async fn start_voice_sidecar<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: State<'_, Arc<VoiceServicesState>>,
    source: Option<String>,
) -> Result<VoiceServiceStatus, String> {
    let arc = state.inner().clone();
    let source = source.unwrap_or_else(|| "mic".into());

    let mut stt_args = vec!["--ws-url".into(), "ws://127.0.0.1:9876".into()];
    if source == "ble" { stt_args.push("--ble".into()); }
    let tts_args = vec!["--host".into(), "127.0.0.1".into(), "--port".into(), "9877".into()];

    start_one(&app, &arc, VoiceServiceKind::Tts, tts_args).await?;
    // Bug 3 fix: kill TTS if STT fails to avoid leaked sidecar.
    if let Err(e) = start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await {
        stop_kind(&arc, VoiceServiceKind::Tts);
        return Err(e);
    }

    voice_sidecar_health(state).await
}

#[tauri::command]
pub async fn stop_voice_sidecar(
    state: State<'_, Arc<VoiceServicesState>>,
) -> Result<(), String> {
    let arc = state.inner();
    // Bug 2 fix: mark intentional + bump generation BEFORE killing, so monitor
    // consumes the sentinel and does not restart.
    let children: Vec<_> = {
        let mut data = arc.data.lock().unwrap();
        let kinds: Vec<_> = data.children.keys().copied().collect();
        for kind in &kinds {
            data.intentional_stops.insert(*kind);
            let next_gen = data.generations.get(kind).copied().unwrap_or(0).wrapping_add(1);
            data.generations.insert(*kind, next_gen);
            data.restart_counts.remove(kind);
            data.last_args.remove(kind);
        }
        data.children.drain().collect()
    };
    for (_, child) in children {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_voice_sidecar<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: State<'_, Arc<VoiceServicesState>>,
    source: Option<String>,
) -> Result<VoiceServiceStatus, String> {
    stop_voice_sidecar(state.clone()).await?;
    sleep(Duration::from_millis(500)).await;

    let arc = state.inner().clone();
    let source = source.unwrap_or_else(|| "mic".into());
    let mut stt_args = vec!["--ws-url".into(), "ws://127.0.0.1:9876".into()];
    if source == "ble" { stt_args.push("--ble".into()); }
    let tts_args = vec!["--host".into(), "127.0.0.1".into(), "--port".into(), "9877".into()];

    start_one(&app, &arc, VoiceServiceKind::Tts, tts_args).await?;
    if let Err(e) = start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await {
        stop_kind(&arc, VoiceServiceKind::Tts);
        return Err(e);
    }

    voice_sidecar_health(state).await
}

#[tauri::command]
pub async fn voice_sidecar_health(
    state: State<'_, Arc<VoiceServicesState>>,
) -> Result<VoiceServiceStatus, String> {
    let (stt_running, tts_running) = {
        let data = state.inner().data.lock().unwrap();
        (
            data.children.contains_key(&VoiceServiceKind::Stt),
            data.children.contains_key(&VoiceServiceKind::Tts),
        )
    };
    Ok(VoiceServiceStatus {
        stt_running,
        tts_running,
        stt_port_open: port_open(STT_PORT).await,
        tts_port_open: port_open(TTS_PORT).await,
    })
}
