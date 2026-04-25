use serde::Serialize;
use std::{
    collections::HashMap,
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

// std::sync::Mutex so lock guards are never held across await points.
#[derive(Default)]
pub struct VoiceServicesState {
    data: Mutex<VoiceData>,
}

#[derive(Default)]
struct VoiceData {
    children: HashMap<VoiceServiceKind, CommandChild>,
    restart_counts: HashMap<VoiceServiceKind, u8>,
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

/// Spawns one sidecar binary (sync). Restart signals travel via channel to
/// avoid recursive async calls and non-Send future issues.
fn spawn_child<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<VoiceServicesState>,
    kind: VoiceServiceKind,
    args: Vec<String>,
    restart_tx: mpsc::UnboundedSender<(VoiceServiceKind, Vec<String>)>,
) -> Result<(), String> {
    let shell = app.shell();
    let mut command = shell
        .sidecar(kind.sidecar_name())
        .map_err(|e| e.to_string())?
        .args(args);

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
                    let should_restart = {
                        let mut data = state2.data.lock().unwrap();
                        data.children.remove(&kind);
                        let count = data.restart_counts.entry(kind).or_insert(0);
                        if *count < MAX_RESTARTS { *count += 1; true } else { false }
                    };

                    let _ = app2.emit(
                        "voice:crashed",
                        VoiceServiceEvent {
                            service: kind.label(),
                            port: kind.port(),
                            reason: Some(format!("terminated code={:?} signal={:?}", term.code, term.signal)),
                        },
                    );

                    if should_restart {
                        sleep(Duration::from_secs(1)).await;
                        let restart_args = match kind {
                            VoiceServiceKind::Stt => vec!["--ws-url".into(), "ws://127.0.0.1:9876".into()],
                            VoiceServiceKind::Tts => vec!["--host".into(), "127.0.0.1".into(), "--port".into(), "9877".into()],
                        };
                        let _ = restart_tx.send((kind, restart_args));
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

/// Restart-coordinator loop: receives (kind, args) restart signals from
/// monitor tasks and re-spawns the sidecar synchronously.
fn start_restart_loop<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: Arc<VoiceServicesState>,
    mut restart_rx: mpsc::UnboundedReceiver<(VoiceServiceKind, Vec<String>)>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some((kind, args)) = restart_rx.recv().await {
            if port_open(kind.port()).await {
                let _ = app.emit(
                    "voice:port_unavailable",
                    VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("port in use during restart".into()) },
                );
                continue;
            }
            let (new_tx, new_rx) = mpsc::unbounded_channel();
            start_restart_loop(app.clone(), state.clone(), new_rx);
            if let Err(e) = spawn_child(&app, &state, kind, args, new_tx) {
                let _ = app.emit(
                    "voice:crashed",
                    VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some(e) },
                );
            }
        }
    });
}

async fn start_one<R: Runtime + 'static>(
    app: &AppHandle<R>,
    state: &Arc<VoiceServicesState>,
    kind: VoiceServiceKind,
    args: Vec<String>,
) -> Result<(), String> {
    if port_open(kind.port()).await {
        let _ = app.emit(
            "voice:port_unavailable",
            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("port already in use".into()) },
        );
        return Err(format!("{} port {} is already in use", kind.label(), kind.port()));
    }
    let (restart_tx, restart_rx) = mpsc::unbounded_channel();
    start_restart_loop(app.clone(), state.clone(), restart_rx);
    spawn_child(app, state, kind, args, restart_tx)
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
    start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await?;

    voice_sidecar_health(state).await
}

#[tauri::command]
pub async fn stop_voice_sidecar<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<VoiceServicesState>>,
) -> Result<(), String> {
    let children: Vec<_> = {
        let mut data = state.inner().data.lock().unwrap();
        data.restart_counts.clear();
        data.children.drain().collect()
    };
    for (kind, child) in children {
        let _ = child.kill();
        let _ = app.emit(
            "voice:stopped",
            VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("stopped by user".into()) },
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_voice_sidecar<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: State<'_, Arc<VoiceServicesState>>,
    source: Option<String>,
) -> Result<VoiceServiceStatus, String> {
    stop_voice_sidecar(app.clone(), state.clone()).await?;
    sleep(Duration::from_millis(500)).await;

    let arc = state.inner().clone();
    let source = source.unwrap_or_else(|| "mic".into());
    let mut stt_args = vec!["--ws-url".into(), "ws://127.0.0.1:9876".into()];
    if source == "ble" { stt_args.push("--ble".into()); }
    let tts_args = vec!["--host".into(), "127.0.0.1".into(), "--port".into(), "9877".into()];

    start_one(&app, &arc, VoiceServiceKind::Tts, tts_args).await?;
    start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await?;

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
