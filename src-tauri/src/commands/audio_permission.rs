// audio_permission.rs — macOS microphone permission gate.
//
// Wraps AVCaptureDevice.authorizationStatusForMediaType: and exposes a
// simple PermissionStatus enum the frontend onboarding wizard (PR-2b)
// can consume.
//
// PR-2a scope:
//   - `current_status()` — synchronous query, safe to call any time
//   - `request_access()` — returns NotDetermined on PR-2a; PR-2b wires
//     the async completion handler and the UI that prompts the user
//
// Non-macOS targets short-circuit to NotSupported so the CI mocked
// lane compiles cleanly on ubuntu-latest without pulling AVFoundation.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    NotDetermined,
    Denied,
    Restricted,
    Authorized,
    NotSupported,
}

impl PermissionStatus {
    pub fn from_raw_av(value: i64) -> Self {
        // AVAuthorizationStatus:
        //   0 = NotDetermined, 1 = Restricted, 2 = Denied, 3 = Authorized
        match value {
            0 => PermissionStatus::NotDetermined,
            1 => PermissionStatus::Restricted,
            2 => PermissionStatus::Denied,
            3 => PermissionStatus::Authorized,
            _ => PermissionStatus::NotSupported,
        }
    }
}

// ── macOS implementation ───────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::PermissionStatus;
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};

    // AVMediaTypeAudio is the Objective-C NSString constant "soun". We
    // construct an NSString with that literal content rather than linking
    // AVFoundation directly — the value is stable across macOS versions.
    fn audio_media_type_ns_string() -> *mut Object {
        unsafe {
            let cls = class!(NSString);
            let ns: *mut Object = msg_send![cls, stringWithUTF8String: b"soun\0".as_ptr()];
            ns
        }
    }

    pub fn current_status() -> PermissionStatus {
        let cls = match Class::get("AVCaptureDevice") {
            Some(c) => c,
            None => return PermissionStatus::NotSupported,
        };
        let media_type = audio_media_type_ns_string();
        if media_type.is_null() {
            return PermissionStatus::NotSupported;
        }
        let raw: i64 = unsafe {
            msg_send![cls, authorizationStatusForMediaType: media_type]
        };
        PermissionStatus::from_raw_av(raw)
    }

    // Scaffolding — PR-2b wires the async completion handler + UI flow.
    pub fn request_access() -> PermissionStatus {
        current_status()
    }
}

#[cfg(target_os = "macos")]
pub fn current_status() -> PermissionStatus {
    macos_impl::current_status()
}

#[cfg(target_os = "macos")]
pub fn request_access() -> PermissionStatus {
    macos_impl::request_access()
}

#[cfg(not(target_os = "macos"))]
pub fn current_status() -> PermissionStatus {
    PermissionStatus::NotSupported
}

#[cfg(not(target_os = "macos"))]
pub fn request_access() -> PermissionStatus {
    PermissionStatus::NotSupported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_raw_av_maps_each_value() {
        assert_eq!(PermissionStatus::from_raw_av(0), PermissionStatus::NotDetermined);
        assert_eq!(PermissionStatus::from_raw_av(1), PermissionStatus::Restricted);
        assert_eq!(PermissionStatus::from_raw_av(2), PermissionStatus::Denied);
        assert_eq!(PermissionStatus::from_raw_av(3), PermissionStatus::Authorized);
        assert_eq!(PermissionStatus::from_raw_av(99), PermissionStatus::NotSupported);
        assert_eq!(PermissionStatus::from_raw_av(-1), PermissionStatus::NotSupported);
    }

    #[test]
    fn status_serde_roundtrip() {
        for v in [
            PermissionStatus::NotDetermined,
            PermissionStatus::Denied,
            PermissionStatus::Restricted,
            PermissionStatus::Authorized,
            PermissionStatus::NotSupported,
        ] {
            let s = serde_json::to_string(&v).expect("serialize");
            let back: PermissionStatus = serde_json::from_str(&s).expect("deserialize");
            assert_eq!(v, back);
        }
    }

    #[test]
    fn serialized_names_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&PermissionStatus::NotDetermined).unwrap(),
            "\"not_determined\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionStatus::NotSupported).unwrap(),
            "\"not_supported\""
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_reports_not_supported() {
        assert_eq!(current_status(), PermissionStatus::NotSupported);
        assert_eq!(request_access(), PermissionStatus::NotSupported);
    }
}
