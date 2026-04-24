// Integration test — exercises the public voice_protocol contract that
// ws_bridge.rs relies on. Unit tests inside the module cover edge cases;
// this file asserts the contract shape callers depend on.

use pixel_terminal_lib::voice_protocol::{
    self, HandshakeResult, HELLO_TIMEOUT_MS, PROTOCOL_VERSION,
};

#[test]
fn public_constants_are_stable() {
    assert_eq!(PROTOCOL_VERSION, "voice/v1");
    assert_eq!(HELLO_TIMEOUT_MS, 2000);
}

#[test]
fn accepts_well_formed_hello() {
    let frame = r#"{"type":"hello","protocol":"voice/v1","client":"pixel_voice_bridge","session_id":"s-1"}"#;
    assert!(matches!(
        voice_protocol::negotiate(frame),
        HandshakeResult::Accepted { .. }
    ));
}

#[test]
fn rejects_legacy_voice_ready_as_first_frame() {
    // This is the v0 client shape — must be rejected.
    let frame = r#"{"type":"voice_ready","source":"mic"}"#;
    match voice_protocol::negotiate(frame) {
        HandshakeResult::Rejected { code, .. } => assert_eq!(code, "unexpected_frame"),
        other => panic!("expected Rejected, got {:?}", other),
    }
}

#[test]
fn rejects_future_protocol_version() {
    let frame = r#"{"type":"hello","protocol":"voice/v2","client":"c","session_id":"s"}"#;
    match voice_protocol::negotiate(frame) {
        HandshakeResult::Rejected { code, .. } => assert_eq!(code, "unsupported_protocol"),
        other => panic!("expected Rejected, got {:?}", other),
    }
}

#[test]
fn hello_ack_contains_version() {
    assert!(voice_protocol::hello_ack().contains(PROTOCOL_VERSION));
}

#[test]
fn error_frame_round_trips_code() {
    let s = voice_protocol::error_frame("handshake_timeout", "no hello within 2s");
    assert!(s.contains("handshake_timeout"));
    assert!(s.contains("no hello within 2s"));
}
