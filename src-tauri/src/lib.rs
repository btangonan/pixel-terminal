use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

pub mod voice_protocol;
mod ws_bridge;
use ws_bridge::{get_voice_status, ptt_release, ptt_start, set_omi_listening, set_voice_mode, switch_voice_source, sync_omi_sessions};

pub mod commands;
pub mod mcp_gate;
use commands::file_io::{append_line_to_file, get_file_size, get_file_size_any, read_file_as_base64, read_file_as_base64_any, read_file_as_text, read_file_as_text_any, write_file_as_text};
use commands::history::{load_session_history, scan_session_history};
use commands::companion::{sync_buddy, reroll_oracle};
use commands::daemon::{start_daemon, DaemonShared};
use commands::oracle::oracle_query;
use commands::mcp_config_writer::{resolve_gate_binary, write_mcp_config};
use commands::misc::{js_log, read_slash_command_content, read_slash_commands};
use commands::supervisor::{supervisor_circuit_state, supervisor_record_gate_crash, supervisor_reset};
use mcp_gate::supervisor::SupervisorState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Start Vexil Master daemon (replaces scripts/vexil_master.py).
            // Manage the shared state so oracle_query command can access sem + session context.
            let daemon_shared = DaemonShared::new();
            app.manage(daemon_shared.clone());
            start_daemon(daemon_shared);

            // P2.G — supervisor state for MCP-gate crash tracking (circuit breaker).
            app.manage(SupervisorState::default());

            ws_bridge::init(app)?;

            // Custom menu — replaces default "About" with "About Anima"
            // and intercepts the About action to show our styled dialog.
            let about_i = MenuItem::with_id(app, "about", "About Anima", true, None::<&str>)?;
            let app_menu = Submenu::with_items(app, "Anima", true, &[
                &about_i,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit Anima", true, Some("CmdOrCtrl+Q"))?,
            ])?;
            let edit_menu = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?,
                &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            let window_menu = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id() == "about" {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.emit("show-about", ());
                    }
                }
                if event.id() == "quit" {
                    // Route through window close so frontend can show confirmation dialog
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.close();
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_as_base64,
            read_file_as_base64_any,
            read_file_as_text,
            read_file_as_text_any,
            get_file_size,
            get_file_size_any,
            read_slash_commands,
            read_slash_command_content,
            sync_omi_sessions,
            set_omi_listening,
            set_voice_mode,
            ptt_start,
            ptt_release,
            switch_voice_source,
            get_voice_status,
            scan_session_history,
            load_session_history,
            js_log,
            write_file_as_text,
            append_line_to_file,
            sync_buddy,
            reroll_oracle,
            oracle_query,
            write_mcp_config,
            resolve_gate_binary,
            supervisor_record_gate_crash,
            supervisor_circuit_state,
            supervisor_reset
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Set dock icon in Ready — runs AFTER Tauri's internal setApplicationIconImage
            // (tauri-2/src/app.rs RuntimeRunEvent::Ready), so our contentView wins.
            if let tauri::RunEvent::Ready = event {
                #[cfg(target_os = "macos")]
                set_squircle_dock_icon();
            }
        });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::commands::file_io::{expand_and_validate_path, read_file_as_text, write_file_as_text};
    use crate::commands::history::load_session_history;

    #[test]
    fn test_path_traversal_blocked() {
        let result = expand_and_validate_path("../../../etc/passwd");
        assert!(result.is_err(), "path traversal should be rejected");
        let msg = result.unwrap_err();
        assert!(msg.contains("traversal") || msg.contains("Relative"), "got: {}", msg);
    }

    #[test]
    fn test_system_path_blocked() {
        let result = expand_and_validate_path("/etc/passwd");
        assert!(result.is_err(), "system path should be rejected");
    }

    #[test]
    fn test_home_root_blocked() {
        let result = expand_and_validate_path("~/secret.txt");
        assert!(result.is_err(), "home-root file outside allowlist should be rejected");
    }

    #[test]
    fn test_ssh_key_blocked() {
        let result = expand_and_validate_path("~/.ssh/id_rsa");
        assert!(result.is_err(), "~/.ssh/ should be rejected");
    }

    #[test]
    fn test_config_pixel_terminal_allowed() {
        let result = expand_and_validate_path("~/.config/pixel-terminal/buddy.json");
        assert!(result.is_ok(), "~/.config/pixel-terminal/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_local_share_pixel_terminal_allowed() {
        let result = expand_and_validate_path("~/.local/share/pixel-terminal/vexil_feed.jsonl");
        assert!(result.is_ok(), "~/.local/share/pixel-terminal/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_projects_allowed() {
        let result = expand_and_validate_path("~/Projects/my-project/file.txt");
        assert!(result.is_ok(), "~/Projects/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_tmp_allowed() {
        let result = expand_and_validate_path("/tmp/pixel_terminal_alive");
        assert!(result.is_ok(), "/tmp/ should be allowed: {:?}", result);
    }

    #[test]
    fn test_claude_json_exact_allowed() {
        let result = expand_and_validate_path("~/.claude.json");
        assert!(result.is_ok(), "~/.claude.json exact path should be allowed: {:?}", result);
    }

    #[test]
    fn test_write_file_rejects_system_path() {
        let result = write_file_as_text("/etc/hosts".to_string(), "evil".to_string());
        assert!(result.is_err(), "writes outside allowed paths should be rejected");
    }

    #[test]
    fn test_read_file_rejects_traversal() {
        let result = read_file_as_text("../../../etc/passwd".to_string());
        assert!(result.is_err(), "path traversal should be rejected by read_file_as_text");
    }

    #[test]
    fn test_absolute_home_path_blocked() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{}/Desktop/evil.txt", home);
        let result = expand_and_validate_path(&path);
        assert!(result.is_err(), "~/Desktop/ should be rejected: {:?}", result);
    }

    #[tokio::test]
    async fn test_load_session_history_rejects_arbitrary_path() {
        let result = load_session_history("/etc/passwd".to_string()).await;
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("~/.claude/projects/"), "got: {}", msg);
    }

    #[tokio::test]
    async fn test_load_session_history_rejects_traversal() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{}/.claude/projects/../../../etc/passwd", home);
        let result = load_session_history(path).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_load_session_history_accepts_valid_project_path() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{}/.claude/projects/test-project/abc123.jsonl", home);
        let result = load_session_history(path).await;
        if let Err(e) = &result {
            assert!(!e.contains("~/.claude/projects/"), "unexpected path rejection: {}", e);
        }
    }
}

/// ─── DOCK ICON — READ BEFORE TOUCHING ────────────────────────────────────────
///
/// WHY THIS IS IN run() AND NOT setup():
///   Tauri v2 calls setApplicationIconImage() internally on RuntimeRunEvent::Ready,
///   which fires AFTER setup(). Anything set in setup() is silently overridden.
///   This function must be called from RunEvent::Ready in the app.run() callback.
///
/// WHY NSDockTile.contentView (NOT setApplicationIconImage):
///   setApplicationIconImage composites the image on an opaque background,
///   stripping alpha transparency → transparent-corner PNGs render as squares.
///   contentView renders an NSView directly, preserving alpha.
///
/// WHY icon_master_1024_rounded.png (NOT icon_master_1024.png):
///   NSDockTile.contentView BYPASSES macOS 26 Tahoe squircle enforcement.
///   The system does NOT apply its squircle mask to contentView content.
///   The squircle must be pre-baked into the PNG (transparent corners).
///   icon_master_1024.png is the flat square — wrong file for this path.
///
/// AFTER CHANGING THE PNG: touch src-tauri/src/lib.rs before rebuilding.
///   include_bytes! is resolved at compile time; cargo won't recompile if only
///   the PNG changed. Skipping the touch = old icon bytes silently re-used.
///
/// See CLAUDE.md §"Dock Icon System" for full context.
/// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
fn set_squircle_dock_icon() {

    use cocoa::base::nil;
    use cocoa::foundation::{NSData, NSPoint, NSRect, NSSize};
    use objc::runtime::Object;
    use objc::*;

    let icon_bytes: &[u8] = include_bytes!("../icons/icon_master_1024_rounded.png");

    unsafe {
        let ns_data = NSData::dataWithBytes_length_(
            nil,
            icon_bytes.as_ptr() as *const std::ffi::c_void,
            icon_bytes.len() as u64,
        );
        let ns_image: *mut Object = msg_send![class!(NSImage), alloc];
        let ns_image: *mut Object = msg_send![ns_image, initWithData: ns_data];
        let _: () = msg_send![ns_image, setSize: NSSize::new(1024.0, 1024.0)];

        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let dock_tile: *mut Object = msg_send![ns_app, dockTile];

        let frame = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: 128.0, height: 128.0 },
        };
        let image_view: *mut Object = msg_send![class!(NSImageView), alloc];
        let image_view: *mut Object = msg_send![image_view, initWithFrame: frame];
        let _: () = msg_send![image_view, setImageScaling: 3u64];
        let _: () = msg_send![image_view, setImage: ns_image];
        let _: () = msg_send![dock_tile, setContentView: image_view];
        let _: () = msg_send![dock_tile, display];
    }
}
