use std::fs;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

mod ws_bridge;
use ws_bridge::{ptt_release, ptt_start, set_omi_listening, set_voice_mode, switch_voice_source, sync_omi_sessions};

#[derive(serde::Serialize)]
struct SlashCommand {
    name: String,
    description: String,
}

/// Strip YAML frontmatter (--- block) from markdown content.
fn strip_frontmatter(content: &str) -> String {
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..]; // skip past "\n---"
            return after.trim_start_matches('\n').to_string();
        }
    }
    content.to_string()
}

/// Read the full body of a slash command file by its frontmatter name.
/// Scans ~/.claude/commands/ (one level of subdirs), matches by name: field,
/// returns content with frontmatter stripped. Returns None if not found.
#[tauri::command]
fn read_slash_command_content(name: String) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    find_command_content(&dir, &name, None)
}

fn find_command_content(dir: &str, target: &str, prefix: Option<&str>) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
            let ns = path.file_name()?.to_str()?.to_string();
            let subdir = path.to_string_lossy().to_string();
            if let Some(content) = find_command_content(&subdir, target, Some(&ns)) {
                return Some(content);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Some(cmd) = parse_frontmatter(&content) {
                let full_name = match prefix {
                    Some(ns) => format!("{}:{}", ns, cmd.name),
                    None => cmd.name,
                };
                if full_name == target {
                    return Some(strip_frontmatter(&content));
                }
            }
        }
    }
    None
}

/// Read ~/.claude/commands/ recursively (one level of subdirs) and return
/// name+description from YAML frontmatter. Subdir commands are prefixed:
/// sm/introspect.md → name "sm:introspect"
#[tauri::command]
fn read_slash_commands() -> Vec<SlashCommand> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{}/.claude/commands", home);
    let mut commands = Vec::new();

    collect_commands(&dir, None, &mut commands);
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

fn collect_commands(dir: &str, prefix: Option<&str>, out: &mut Vec<SlashCommand>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
            // Recurse one level: folder name becomes the namespace prefix
            let ns = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let subdir = path.to_string_lossy().to_string();
            collect_commands(&subdir, Some(&ns), out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let content = match fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if let Some(mut cmd) = parse_frontmatter(&content) {
                if let Some(ns) = prefix {
                    cmd.name = format!("{}:{}", ns, cmd.name);
                }
                out.push(cmd);
            }
        }
    }
}

fn parse_frontmatter(content: &str) -> Option<SlashCommand> {
    let inner = content.strip_prefix("---\n")?.split("\n---").next()?;
    let name = inner.lines()
        .find(|l| l.starts_with("name:"))?
        .trim_start_matches("name:")
        .trim()
        .to_string();
    let desc_line = inner.lines()
        .find(|l| l.starts_with("description:"))?
        .trim_start_matches("description:")
        .trim()
        .trim_matches('"')
        .to_string();
    Some(SlashCommand { name, description: desc_line })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            ws_bridge::init(app)?;

            // Custom menu — replaces "About pixel-terminal" with "About Pixel Claude"
            // and intercepts the About action to show our styled dialog.
            let about_i = MenuItem::with_id(app, "about", "About Pixel Claude", true, None::<&str>)?;
            let app_menu = Submenu::with_items(app, "Pixel Claude", true, &[
                &about_i,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
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
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_slash_commands,
            read_slash_command_content,
            sync_omi_sessions,
            set_omi_listening,
            set_voice_mode,
            ptt_start,
            ptt_release,
            switch_voice_source
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
