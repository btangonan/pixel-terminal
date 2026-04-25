// voice_protocol.rs — Strict WS handshake for voice clients (protocol v1).
//
// First frame a client sends after WS upgrade MUST be a valid `hello` with
// `protocol == PROTOCOL_VERSION`. Servers reply with `hello_ack` or an
// `error` frame followed by a close. Unversioned clients are rejected.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "voice/v1";
pub const HELLO_TIMEOUT_MS: u64 = 2000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HandshakeFrame {
    Hello {
        protocol: String,
        client: String,
        session_id: String,
    },
    HelloAck {
        protocol: String,
        server: String,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, PartialEq)]
pub enum HandshakeResult {
    Accepted { client: String, session_id: String },
    Rejected { code: String, message: String },
}

pub fn negotiate(first_message: &str) -> HandshakeResult {
    // Two-step parse so we can distinguish "malformed JSON" from
    // "valid JSON, wrong type" — they map to different error codes.
    let value: serde_json::Value = match serde_json::from_str(first_message) {
        Ok(v) => v,
        Err(_) => {
            return HandshakeResult::Rejected {
                code: "invalid_handshake".into(),
                message: "first frame must be valid JSON".into(),
            };
        }
    };

    let frame_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if frame_type != "hello" {
        return HandshakeResult::Rejected {
            code: "unexpected_frame".into(),
            message: format!("first frame must be hello, got type={:?}", frame_type),
        };
    }

    let parsed: Result<HandshakeFrame, _> = serde_json::from_value(value);
    match parsed {
        Ok(HandshakeFrame::Hello { protocol, client, session_id }) => {
            if protocol != PROTOCOL_VERSION {
                return HandshakeResult::Rejected {
                    code: "unsupported_protocol".into(),
                    message: format!(
                        "server requires {}, client offered {}",
                        PROTOCOL_VERSION, protocol
                    ),
                };
            }
            if client.is_empty() || session_id.is_empty() {
                return HandshakeResult::Rejected {
                    code: "invalid_handshake".into(),
                    message: "client and session_id are required".into(),
                };
            }
            HandshakeResult::Accepted { client, session_id }
        }
        Ok(_) => HandshakeResult::Rejected {
            code: "unexpected_frame".into(),
            message: "first frame must be hello".into(),
        },
        Err(_) => HandshakeResult::Rejected {
            code: "invalid_handshake".into(),
            message: "hello frame is missing required fields".into(),
        },
    }
}

pub fn hello_ack() -> String {
    serde_json::to_string(&HandshakeFrame::HelloAck {
        protocol: PROTOCOL_VERSION.into(),
        server: "anima".into(),
    })
    .expect("hello_ack serialization cannot fail")
}

pub fn error_frame(code: &str, message: &str) -> String {
    serde_json::to_string(&HandshakeFrame::Error {
        code: code.into(),
        message: message.into(),
    })
    .expect("error_frame serialization cannot fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_hello() {
        let frame = r#"{"type":"hello","protocol":"voice/v1","client":"pixel_voice_bridge","session_id":"abc-123"}"#;
        match negotiate(frame) {
            HandshakeResult::Accepted { client, session_id } => {
                assert_eq!(client, "pixel_voice_bridge");
                assert_eq!(session_id, "abc-123");
            }
            other => panic!("expected Accepted, got {:?}", other),
        }
    }

    #[test]
    fn rejects_unversioned_voice_ready() {
        let frame = r#"{"type":"voice_ready","source":"mic"}"#;
        match negotiate(frame) {
            HandshakeResult::Rejected { code, .. } => assert_eq!(code, "unexpected_frame"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn rejects_wrong_protocol_version() {
        let frame = r#"{"type":"hello","protocol":"voice/v0","client":"x","session_id":"y"}"#;
        match negotiate(frame) {
            HandshakeResult::Rejected { code, .. } => assert_eq!(code, "unsupported_protocol"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn rejects_empty_session_id() {
        let frame = r#"{"type":"hello","protocol":"voice/v1","client":"x","session_id":""}"#;
        match negotiate(frame) {
            HandshakeResult::Rejected { code, .. } => assert_eq!(code, "invalid_handshake"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn rejects_empty_client() {
        let frame = r#"{"type":"hello","protocol":"voice/v1","client":"","session_id":"x"}"#;
        match negotiate(frame) {
            HandshakeResult::Rejected { code, .. } => assert_eq!(code, "invalid_handshake"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn rejects_malformed_json() {
        match negotiate("not-json") {
            HandshakeResult::Rejected { code, .. } => assert_eq!(code, "invalid_handshake"),
            other => panic!("expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn accepts_omi_cloud_default_session_id() {
        let frame = r#"{"type":"hello","protocol":"voice/v1","client":"omi_bridge","session_id":"omi-cloud-default"}"#;
        match negotiate(frame) {
            HandshakeResult::Accepted { session_id, .. } => {
                assert_eq!(session_id, "omi-cloud-default");
            }
            other => panic!("expected Accepted, got {:?}", other),
        }
    }

    #[test]
    fn hello_ack_roundtrips() {
        let s = hello_ack();
        let parsed: HandshakeFrame = serde_json::from_str(&s).unwrap();
        match parsed {
            HandshakeFrame::HelloAck { protocol, server } => {
                assert_eq!(protocol, PROTOCOL_VERSION);
                assert_eq!(server, "anima");
            }
            other => panic!("expected HelloAck, got {:?}", other),
        }
    }

    #[test]
    fn error_frame_roundtrips() {
        let s = error_frame("unsupported_protocol", "voice/v2 not supported");
        let parsed: HandshakeFrame = serde_json::from_str(&s).unwrap();
        match parsed {
            HandshakeFrame::Error { code, message } => {
                assert_eq!(code, "unsupported_protocol");
                assert_eq!(message, "voice/v2 not supported");
            }
            other => panic!("expected Error, got {:?}", other),
        }
    }
}
