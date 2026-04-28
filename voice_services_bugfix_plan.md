# Grade-A Fix Plan: `voice_services.rs` Debug Pass Bugs

Source read completely: `/Users/bradleytangonan/Projects/pixel-terminal/src-tauri/src/commands/voice_services.rs` is 300 lines.

This plan keeps `std::sync::Mutex`, avoids holding lock guards across `await`, and fixes the restart semantics with one coherent state model:

- `intentional_stops`: sentinel consumed by monitor tasks after user-directed kills.
- `generations`: monotonic per-service generation counter that invalidates old monitor tasks and stale restart messages.
- `last_args`: per-service startup arguments so crash restart preserves `--ble`.
- restart channel payload includes generation and args captured from the original spawn.
- TTS-only port ownership checks, because STT connects to `ws_bridge` on 9876 and does not bind it.

## Bug 1: STT Port Check Is Wrong

Problem:

- Line 211 calls `port_open(kind.port()).await` for both services.
- `VoiceServiceKind::Stt.port()` is 9876, but 9876 is owned by `ws_bridge.rs`.
- STT is a client of 9876, so the guard falsely blocks valid STT startup.

Fix:

- Only TTS gets a port availability guard in `start_one`.
- Do the same in the restart coordinator so crash-restarting STT is not blocked by the websocket bridge.

Exact replacement for lines 205-221:

```rust
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
        return Err(format!("{} port {} is already in use", kind.label(), kind.port()));
    }

    let generation = {
        let mut data = state.data.lock().unwrap();
        data.intentional_stops.remove(&kind);
        let generation = data.generations.entry(kind).or_insert(0);
        *generation = generation.wrapping_add(1);
        data.restart_counts.insert(kind, 0);
        data.last_args.insert(kind, args.clone());
        *generation
    };

    let (restart_tx, restart_rx) = mpsc::unbounded_channel();
    start_restart_loop(app.clone(), state.clone(), restart_rx);
    spawn_child(app, state, kind, args, generation, restart_tx)
}
```

Exact replacement for lines 185-192 inside `start_restart_loop`:

```rust
        while let Some((kind, generation, args)) = restart_rx.recv().await {
            let is_current_generation = {
                let data = state.data.lock().unwrap();
                data.generations.get(&kind).copied() == Some(generation)
            };
            if !is_current_generation {
                continue;
            }

            if kind == VoiceServiceKind::Tts && port_open(kind.port()).await {
                let _ = app.emit(
                    "voice:port_unavailable",
                    VoiceServiceEvent { service: kind.label(), port: kind.port(), reason: Some("port in use during restart".into()) },
                );
                continue;
            }
```

Why this is race-safe:

- The only `await` in the availability path happens before spawning and after the generation check.
- STT never probes the bridge-owned port before spawning.

## Bug 2: `stop_voice_sidecar` Auto-Restarts Sidecars

Problem:

- Lines 247-250 clear `restart_counts` and drain children.
- Killing children emits `CommandEvent::Terminated`.
- The monitor sees restart count 0 and restarts the sidecar.

Fix:

- Add `intentional_stops` to shared state.
- Mark every drained child as intentionally stopped before killing it.
- In the monitor, remove the child, consume the sentinel, emit `voice:stopped`, and skip crash emit/restart.
- Do not clear restart counts before killing, because that actively enables the bug.

Exact replacement for lines 48-52:

```rust
#[derive(Default)]
struct VoiceData {
    children: HashMap<VoiceServiceKind, CommandChild>,
    restart_counts: HashMap<VoiceServiceKind, u8>,
    intentional_stops: HashSet<VoiceServiceKind>,
    generations: HashMap<VoiceServiceKind, u64>,
    last_args: HashMap<VoiceServiceKind, Vec<String>>,
}
```

Exact replacement for import lines 2-6:

```rust
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
```

Exact replacement for lines 242-260:

```rust
#[tauri::command]
pub async fn stop_voice_sidecar<R: Runtime>(
    state: State<'_, Arc<VoiceServicesState>>,
) -> Result<(), String> {
    let children: Vec<_> = {
        let mut data = state.inner().data.lock().unwrap();
        let kinds: Vec<_> = data.children.keys().copied().collect();
        for kind in kinds {
            data.intentional_stops.insert(kind);
            let generation = data.generations.entry(kind).or_insert(0);
            *generation = generation.wrapping_add(1);
            data.restart_counts.remove(&kind);
            data.last_args.remove(&kind);
        }
        data.children.drain().collect()
    };

    for (_, child) in children {
        let _ = child.kill();
    }

    Ok(())
}
```

Required call-site change in `restart_voice_sidecar`, line 268:

```rust
    stop_voice_sidecar(state.clone()).await?;
```

Why this is race-safe:

- The sentinel is inserted while the child is still in `children`, before `kill()`.
- The monitor consumes the sentinel under the same mutex that removes the child.
- The stop command no longer emits `voice:stopped` directly, preventing duplicate stopped events when the monitor also observes termination.
- `app` is removed from the stop command because the monitor owns the authoritative stopped/crashed event after the actual process termination.

## Bug 3: Partial Start Leaks TTS

Problem:

- Lines 236-237 start TTS first, then STT.
- If STT fails, TTS remains running.

Fix:

- Use explicit error handling around STT startup.
- If STT fails, intentionally stop the already-started TTS and return the STT error.

Exact replacement for lines 236-237:

```rust
    start_one(&app, &arc, VoiceServiceKind::Tts, tts_args).await?;
    if let Err(e) = start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await {
        stop_kind(&arc, VoiceServiceKind::Tts);
        return Err(e);
    }
```

Add this helper after `start_one` and before `start_voice_sidecar`:

```rust
fn stop_kind(state: &Arc<VoiceServicesState>, kind: VoiceServiceKind) {
    let child = {
        let mut data = state.data.lock().unwrap();
        data.intentional_stops.insert(kind);
        let generation = data.generations.entry(kind).or_insert(0);
        *generation = generation.wrapping_add(1);
        data.restart_counts.remove(&kind);
        data.last_args.remove(&kind);
        data.children.remove(&kind)
    };

    if let Some(child) = child {
        let _ = child.kill();
    }
}
```

Apply the same cleanup pattern in `restart_voice_sidecar` when STT fails after TTS was restarted:

Exact replacement for lines 277-278:

```rust
    start_one(&app, &arc, VoiceServiceKind::Tts, tts_args).await?;
    if let Err(e) = start_one(&app, &arc, VoiceServiceKind::Stt, stt_args).await {
        stop_kind(&arc, VoiceServiceKind::Tts);
        return Err(e);
    }
```

Why this is race-safe:

- `stop_kind` marks intentional stop and bumps generation before killing.
- Any monitor for the killed TTS sees intentional stop or a stale generation and does not restart it.

## Bug 4: `restart_voice_sidecar` Races With Old Monitor Tasks

Problem:

- Lines 268-269 stop then sleep for 500ms.
- Old monitor tasks can still receive `Terminated`, sleep, and enqueue a restart after new children are already started.

Fix:

- Use a per-service generation counter.
- `start_one` creates a new generation and passes it to `spawn_child`.
- `stop_voice_sidecar` and `stop_kind` also bump generation, invalidating old monitors and pending restart messages.
- The monitor checks its captured generation before counting/restarting.
- The restart coordinator checks generation again before spawning.

Exact signature replacement for lines 83-89:

```rust
fn spawn_child<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<VoiceServicesState>,
    kind: VoiceServiceKind,
    args: Vec<String>,
    generation: u64,
    restart_tx: mpsc::UnboundedSender<(VoiceServiceKind, u64, Vec<String>)>,
) -> Result<(), String> {
```

Exact replacement for line 94:

```rust
        .args(args.clone());
```

Exact replacement for lines 130-172:

```rust
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Terminated(term) => {
                    let (should_restart, intentional_stop, restart_args) = {
                        let mut data = state2.data.lock().unwrap();
                        data.children.remove(&kind);

                        if data.generations.get(&kind).copied() != Some(generation) {
                            (false, false, None)
                        } else if data.intentional_stops.remove(&kind) {
                            data.restart_counts.remove(&kind);
                            data.last_args.remove(&kind);
                            (false, true, None)
                        } else {
                            let count = data.restart_counts.entry(kind).or_insert(0);
                            let should_restart = *count < MAX_RESTARTS;
                            if should_restart {
                                *count += 1;
                            }
                            let restart_args = if should_restart {
                                data.last_args.get(&kind).cloned().or_else(|| Some(args.clone()))
                            } else {
                                None
                            };
                            (should_restart, false, restart_args)
                        }
                    };

                    if intentional_stop {
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
                        let is_current_generation = {
                            let data = state2.data.lock().unwrap();
                            data.generations.get(&kind).copied() == Some(generation)
                        };
                        if is_current_generation {
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
```

Exact signature replacement for lines 179-183:

```rust
fn start_restart_loop<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: Arc<VoiceServicesState>,
    mut restart_rx: mpsc::UnboundedReceiver<(VoiceServiceKind, u64, Vec<String>)>,
) {
```

Exact replacement for lines 193-195:

```rust
            let (new_tx, new_rx) = mpsc::unbounded_channel();
            start_restart_loop(app.clone(), state.clone(), new_rx);
            if let Err(e) = spawn_child(&app, &state, kind, args, generation, new_tx) {
```

Why this is race-safe:

- The old monitor can wake up late, but its generation is no longer current.
- The restart coordinator also rejects stale messages, so even a queued restart message cannot spawn an obsolete process.
- `std::sync::Mutex` is used only for short synchronous sections and never held across `sleep` or `port_open`.

## Bug 5: Auto-Restart Drops BLE Source

Problem:

- Lines 152-155 hardcode STT restart args without `--ble`.
- If initial start used BLE, crash restart silently switches to microphone mode.

Fix:

- Preserve initial args in `VoiceData::last_args`.
- Capture `args.clone()` in each monitor.
- On crash, restart with `data.last_args.get(&kind).cloned().or_else(|| Some(args.clone()))`.
- Remove the hardcoded `match kind` restart args block completely.

The monitor replacement in Bug 4 is the exact code replacement for this bug. The critical removed block is lines 152-155:

```rust
                        let restart_args = match kind {
                            VoiceServiceKind::Stt => vec!["--ws-url".into(), "ws://127.0.0.1:9876".into()],
                            VoiceServiceKind::Tts => vec!["--host".into(), "127.0.0.1".into(), "--port".into(), "9877".into()],
                        };
```

It is replaced by:

```rust
                            let restart_args = if should_restart {
                                data.last_args.get(&kind).cloned().or_else(|| Some(args.clone()))
                            } else {
                                None
                            };
```

Why this is race-safe:

- Args are written under the mutex before spawn.
- Args are read under the mutex when the monitor decides whether to restart.
- The fallback `args.clone()` belongs to the same monitor generation, so it cannot introduce a newer source mode into an older task.

## Bug 6: `voice.js` Still Uses `Command.create sh -c`

Status:

- Intentional PR 1 scope decision.
- No change in this PR.
- Track as PR 2 work, because it affects frontend process invocation rather than the backend sidecar lifecycle fixed here.

Plan note:

```text
PR 2: replace frontend `Command.create("sh", ["-c", ...])` path in `voice.js` with the intended direct sidecar/command invocation after backend lifecycle fixes land.
```

## Consolidated Patch Shape

The intended final Rust behavior is:

1. `start_one(Tts)` checks 9877 before spawn.
2. `start_one(Stt)` does not check 9876 before spawn.
3. Every normal start creates a fresh generation, clears intentional-stop state, resets restart count, and stores args.
4. Every monitor owns one `(kind, generation, args)` tuple.
5. A terminated monitor removes the child, then:
   - ignores stale generations;
   - consumes intentional stop and emits `voice:stopped`;
   - otherwise emits `voice:crashed`, waits one second, re-checks generation, and sends restart with preserved args.
6. Restart coordinator rejects stale generation messages and only checks port availability for TTS.
7. `stop_voice_sidecar` marks all current children intentional, bumps their generations, drains children, and kills them.
8. Partial STT startup failure kills the already-started TTS through `stop_kind`.

## Suggested Verification

Run after implementation:

```bash
cargo fmt
cargo check
```

Manual checks:

1. Start with `source = "mic"` while `ws_bridge` already owns 9876. STT must start and no `voice:port_unavailable` should fire for STT.
2. Start with `source = "ble"`, kill `anima-stt`, and confirm restarted STT includes `--ble`.
3. Start services, call `stop_voice_sidecar`, and confirm no sidecar auto-restarts after termination.
4. Call `restart_voice_sidecar` repeatedly and confirm old monitors do not spawn duplicate sidecars after new children start.
5. Force STT spawn failure after TTS starts and confirm TTS is killed and does not restart.

## Self Grade

Grade: A

Justification:

- Addresses all five backend defects with a single consistent lifecycle model instead of isolated patches.
- Avoids new async lifetime and `Send` issues by keeping `std::sync::Mutex` and never holding guards across `await`.
- Fixes both restart race windows: late monitor wakeups and queued stale restart messages.
- Preserves BLE args without hardcoded restart defaults.
- Cleans up partial-start failure deterministically.
- Correctly treats Bug 6 as PR 2 scope and leaves `voice.js` unchanged for this PR.
