// Exercises: /Users/bradleytangonan/Projects/pixel-terminal/src-tauri/src/ws_bridge.rs
// Failure trigger: removing PTT intent persistence/replay so ptt_start sent before sidecar registration is dropped
// Mocked boundaries (only): STT model inference

use pixel_terminal_lib::ws_bridge::OmiBridgeState;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

async fn recv_type(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
    let raw = timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out waiting for bridge frame")
        .expect("bridge frame channel closed");
    let val: Value = serde_json::from_str(&raw).expect("bridge frame is valid JSON");
    val.get("type")
        .and_then(Value::as_str)
        .expect("bridge frame has type")
        .to_string()
}

#[tokio::test]
async fn ptt_start_sent_before_pixel_voice_bridge_registration_is_replayed() {
    let state = OmiBridgeState::new_for_tests();

    state.set_ptt_active_and_broadcast(true).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    state.send_initial_client_state(&tx, true);

    assert_eq!(recv_type(&mut rx).await, "unmute");
    assert_eq!(recv_type(&mut rx).await, "ptt_start");
}

#[tokio::test]
async fn ptt_replay_is_only_for_pixel_voice_bridge_clients() {
    let state = OmiBridgeState::new_for_tests();

    state.set_ptt_active_and_broadcast(true).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    state.send_initial_client_state(&tx, false);

    assert_eq!(recv_type(&mut rx).await, "unmute");
    assert!(timeout(Duration::from_millis(100), rx.recv())
        .await
        .is_err());
}

#[tokio::test]
async fn ptt_release_clears_replay_intent() {
    let state = OmiBridgeState::new_for_tests();

    state.set_ptt_active_and_broadcast(true).await;
    state.set_ptt_active_and_broadcast(false).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    state.send_initial_client_state(&tx, true);

    assert_eq!(recv_type(&mut rx).await, "unmute");
    assert!(timeout(Duration::from_millis(100), rx.recv())
        .await
        .is_err());
}
