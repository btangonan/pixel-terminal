# Voice Protocol v1

Session-scoped handshake for clients connecting to Anima's voice WebSocket
bridge (`ws://127.0.0.1:9876`).

## Why

Previously the bridge accepted any JSON message as a command. A legacy
client sending `voice_ready` would immediately register as a voice source
without ever identifying itself or its session context. That made two
bugs impossible to prevent:

1. **Cross-session contamination.** A stray client could inject commands
   into the active session because there was no session binding.
2. **Mixed-version drift.** A future server change could not safely
   assume anything about what the client understood.

Protocol v1 closes both by requiring every client to announce itself
before sending anything else.

## Handshake

Immediately after the WebSocket upgrade completes, the client MUST send
exactly one text frame:

```json
{
  "type": "hello",
  "protocol": "voice/v1",
  "client": "pixel_voice_bridge" | "omi_bridge" | "<name>",
  "session_id": "<uuid or stable identifier>"
}
```

The server replies with one of:

```json
{"type": "hello_ack", "protocol": "voice/v1", "server": "anima"}
```

```json
{"type": "error", "code": "<reason>", "message": "<human-readable>"}
```

followed by a close frame when rejected.

## Rejection reasons

| Code                   | Meaning                                                     |
|------------------------|-------------------------------------------------------------|
| `unsupported_protocol` | Client's `protocol` does not match `voice/v1`.              |
| `unexpected_frame`     | First frame parsed as valid JSON but was not a `hello`.     |
| `invalid_handshake`    | JSON malformed or required fields empty.                    |
| `handshake_timeout`    | Client did not send a `hello` within 2 seconds.             |

All four are terminal — the server closes the connection after sending
the error frame. Clients must not retry on the same socket.

## Session IDs

- **pixel_voice_bridge** (local mic/BLE path): generate a fresh UUID per
  bridge process; survives reconnects within the same process.
- **omi_bridge** (cloud relay in OmiWebhook): stamps the literal string
  `"omi-cloud-default"` because the Omi cloud path is shared across all
  incoming Omi users and has no per-user session context at this layer.
  Per-user routing happens upstream in the webhook, not in the bridge.

A future PR (not in PR-0 scope) will use `session_id` to route commands
and audio to a specific session's emitter. PR-0 only validates the
handshake — the id is captured but not yet propagated into events.

## Rollback

PR-0 is a structural change and cannot be rolled back with an env flag.
Revert the PR's commits to restore the pre-handshake behavior. All
dependent PRs (PR-A/B/C/D) assume the handshake is in place.

## Test matrix

`src-tauri/src/voice_protocol.rs` unit tests cover:

- Accepts a well-formed hello.
- Rejects the legacy `voice_ready` first frame.
- Rejects a mismatched protocol version.
- Rejects empty `client` or `session_id`.
- Rejects non-JSON first frames.
- Accepts the `"omi-cloud-default"` sentinel.
- Round-trips `hello_ack` and `error` frames through serde.

`src-tauri/tests/voice_protocol_test.rs` asserts the public API contract
that `ws_bridge.rs` depends on (constants, accept/reject verdicts, frame
shapes).
