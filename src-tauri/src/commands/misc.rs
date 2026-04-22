use std::fs;

#[derive(serde::Serialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub flags: Vec<String>,
}

/// Internal parsed frontmatter (richer than the serialized struct).
struct FrontmatterData {
    name: String,
    description: String,
    flags: Vec<String>,
    /// True when command frontmatter declares `override: true`, meaning it
    /// should win over a same-named skill entry. See dedupe logic in read_slash_commands().
    is_override: bool,
}

/// Strip YAML frontmatter (--- block) from markdown content.
fn strip_frontmatter(content: &str) -> String {
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..];
            return after.trim_start_matches('\n').to_string();
        }
    }
    content.to_string()
}

/// Parse a `flags: [a, b, c]` YAML flow sequence into bare flag names (no `--` prefix).
/// Accepts quoted/unquoted tokens. Strips any accidental `--` prefix the author added.
/// Filters out empty strings so `flags: []` yields `[]` (not `[""]`).
fn parse_flags(line_value: &str) -> Vec<String> {
    let inner = line_value
        .trim()
        .trim_matches(|c| c == '[' || c == ']');
    inner
        .split(',')
        .map(|s| {
            s.trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim_start_matches("--")
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_frontmatter(content: &str) -> Option<FrontmatterData> {
    let inner = content.strip_prefix("---\n")?.split("\n---").next()?;
    let name = inner
        .lines()
        .find(|l| l.starts_with("name:"))?
        .trim_start_matches("name:")
        .trim()
        .trim_matches('"')
        .to_string();
    let description = inner
        .lines()
        .find(|l| l.starts_with("description:"))?
        .trim_start_matches("description:")
        .trim()
        .trim_matches('"')
        .to_string();
    let flags = inner
        .lines()
        .find(|l| l.starts_with("flags:"))
        .map(|l| parse_flags(l.trim_start_matches("flags:")))
        .unwrap_or_default();
    let is_override = inner
        .lines()
        .any(|l| l.starts_with("override:") && l.contains("true"));
    Some(FrontmatterData { name, description, flags, is_override })
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
            if let Some(fm) = parse_frontmatter(&content) {
                let full_name = match prefix {
                    Some(ns) => format!("{}:{}", ns, fm.name),
                    None => fm.name,
                };
                if full_name == target {
                    return Some(strip_frontmatter(&content));
                }
            }
        }
    }
    None
}

/// Walk ~/.claude/commands/ (one namespace level deep).
fn collect_commands(dir: &str, prefix: Option<&str>, out: &mut Vec<(String, FrontmatterData)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && prefix.is_none() {
            let ns = path
                .file_name()
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
            if let Some(mut fm) = parse_frontmatter(&content) {
                if let Some(ns) = prefix {
                    fm.name = format!("{}:{}", ns, fm.name);
                }
                let key = fm.name.clone();
                out.push((key, fm));
            }
        }
    }
}

/// Walk a skills directory — each immediate subdirectory is a skill; read its SKILL.md.
/// Symlinks are followed by default on macOS via is_dir().
/// When `prefix` is Some, each skill name is namespaced as "{prefix}:{name}" (used for plugin skills).
fn collect_skills(dir: &str, prefix: Option<&str>, out: &mut Vec<(String, FrontmatterData)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Only read exactly "SKILL.md" — rejects SKILL.md.bak and other siblings.
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let content = match fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        match parse_frontmatter(&content) {
            Some(mut fm) => {
                if let Some(ns) = prefix {
                    fm.name = format!("{}:{}", ns, fm.name);
                }
                let key = fm.name.clone();
                out.push((key, fm));
            }
            None => {
                eprintln!("[slash] skills/{dir_name}/SKILL.md: malformed frontmatter, skipping");
            }
        }
    }
}

/// Read enabled plugin install paths from ~/.claude/plugins/installed_plugins.json
/// + ~/.claude/settings.json#enabledPlugins. Returns (plugin_namespace, install_path) pairs
/// only for plugins where enabledPlugins[id] === true. Plugin id `name@marketplace`
/// is namespaced as just `name` (matches CLI plugin namespacing).
/// Tolerates missing/malformed files: returns empty vec.
fn enabled_plugin_install_paths(home: &str) -> Vec<(String, String)> {
    let manifest_path = format!("{}/.claude/plugins/installed_plugins.json", home);
    let settings_path = format!("{}/.claude/settings.json", home);

    let manifest_text = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let manifest: serde_json::Value = match serde_json::from_str(&manifest_text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let plugins_obj = match manifest.get("plugins").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return Vec::new(),
    };

    let enabled: serde_json::Map<String, serde_json::Value> = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("enabledPlugins").cloned())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    let mut out: Vec<(String, String)> = Vec::new();
    for (plugin_id, records) in plugins_obj {
        // Plugin must be explicitly enabled (default = disabled).
        if !enabled.get(plugin_id).and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let arr = match records.as_array() {
            Some(a) => a,
            None => continue,
        };
        // Take first install record (matches CLI behavior).
        let install_path = match arr.first()
            .and_then(|r| r.get("installPath"))
            .and_then(|v| v.as_str())
        {
            Some(p) => p.to_string(),
            None => continue,
        };
        // Namespace = plugin id minus "@marketplace" suffix.
        let ns = plugin_id.split('@').next().unwrap_or(plugin_id).to_string();
        out.push((ns, install_path));
    }
    out
}

/// Read all slash commands from ~/.claude/skills/ and ~/.claude/commands/.
/// Skills are the canonical source and win on name collision unless the command
/// declares `override: true` in its frontmatter.
#[tauri::command]
pub fn read_slash_commands() -> Vec<SlashCommand> {
    let home = std::env::var("HOME").unwrap_or_default();

    // 1. Skills first — richer, actively maintained.
    let mut skills: Vec<(String, FrontmatterData)> = Vec::new();
    collect_skills(&format!("{}/.claude/skills", home), None, &mut skills);

    // 1b. Plugin skills — discover via installed_plugins.json + enabledPlugins.
    //     Each enabled plugin's ${installPath}/skills/ is scanned with namespace prefix.
    //     Plugins without a skills/ dir (e.g. rust-analyzer-lsp) are silently skipped.
    for (plugin_ns, install_path) in enabled_plugin_install_paths(&home) {
        let plugin_skills_dir = format!("{}/skills", install_path);
        collect_skills(&plugin_skills_dir, Some(&plugin_ns), &mut skills);
    }

    // 2. Commands — fill gaps only. Skip any name already claimed by a skill,
    //    unless the command declares `override: true`.
    let mut commands: Vec<(String, FrontmatterData)> = Vec::new();
    collect_commands(&format!("{}/.claude/commands", home), None, &mut commands);

    let skill_names: std::collections::HashSet<String> =
        skills.iter().map(|(k, _)| k.clone()).collect();

    let mut out: Vec<SlashCommand> = skills
        .into_iter()
        .map(|(_, fm)| SlashCommand {
            name: fm.name,
            description: fm.description,
            flags: fm.flags,
        })
        .collect();

    for (key, fm) in commands {
        if skill_names.contains(&key) {
            if fm.is_override {
                // Command explicitly overrides the skill — replace in place.
                if let Some(pos) = out.iter().position(|c| c.name == key) {
                    out[pos] = SlashCommand {
                        name: fm.name,
                        description: fm.description,
                        flags: fm.flags,
                    };
                }
            } else {
                eprintln!(
                    "[slash] dedupe: command '{key}' hidden by skill; add `override: true` to force"
                );
            }
        } else {
            out.push(SlashCommand {
                name: fm.name,
                description: fm.description,
                flags: fm.flags,
            });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Read the full body of a slash command / skill by its frontmatter name.
/// Resolution order:
///   1. Plugin namespaced skill (`<plugin>:<skill>`) — read from enabled plugin's installPath
///   2. Local skill — `~/.claude/skills/<name>/SKILL.md` (matched by frontmatter name, not dir name)
///   3. Local command — `~/.claude/commands/<name>.md` (existing behavior, supports namespace dirs)
#[tauri::command]
pub fn read_slash_command_content(name: String) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();

    // 1. Plugin namespaced skill (`<plugin>:<skill>`).
    if let Some((plugin_ns, skill_name)) = name.split_once(':') {
        for (ns, install_path) in enabled_plugin_install_paths(&home) {
            if ns != plugin_ns {
                continue;
            }
            let plugin_skills_dir = format!("{}/skills", install_path);
            if let Some(content) = find_skill_content(&plugin_skills_dir, skill_name) {
                return Some(content);
            }
        }
    }

    // 2. Local skill.
    let skills_dir = format!("{}/.claude/skills", home);
    if let Some(content) = find_skill_content(&skills_dir, &name) {
        return Some(content);
    }

    // 3. Local command.
    let commands_dir = format!("{}/.claude/commands", home);
    find_command_content(&commands_dir, &name, None)
}

/// Walk a skills directory looking for a skill whose frontmatter `name` matches `target`.
/// Returns the body (with frontmatter stripped) or None.
fn find_skill_content(dir: &str, target: &str) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        let content = match fs::read_to_string(&skill_md) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if let Some(fm) = parse_frontmatter(&content) {
            if fm.name == target {
                return Some(strip_frontmatter(&content));
            }
        }
    }
    None
}

/// Forward JS console.log to terminal for debugging.
#[tauri::command]
pub fn js_log(msg: String) {
    println!("[webview] {}", msg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_command() {
        let content = "---\nname: plan\ndescription: Enter planning mode\n---\n\nbody";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.name, "plan");
        assert_eq!(fm.description, "Enter planning mode");
        assert!(fm.flags.is_empty());
        assert!(!fm.is_override);
    }

    #[test]
    fn parses_quoted_description() {
        let content =
            "---\nname: checkpoint\ndescription: \"Session checkpoint — captures decisions\"\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.description, "Session checkpoint — captures decisions");
    }

    #[test]
    fn parses_flags_list() {
        let content = "---\nname: impeccable\ndescription: Frontend skill\nflags: [craft, teach, extract]\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.flags, vec!["craft", "teach", "extract"]);
    }

    #[test]
    fn parses_single_flag() {
        let content = "---\nname: x\ndescription: y\nflags: [retro]\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.flags, vec!["retro"]);
    }

    #[test]
    fn parses_empty_flags() {
        let content = "---\nname: x\ndescription: y\nflags: []\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert!(fm.flags.is_empty(), "empty flags must not produce a \"\" token");
    }

    #[test]
    fn parses_hyphenated_flag() {
        let content = "---\nname: x\ndescription: y\nflags: [think-hard, state-only]\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.flags, vec!["think-hard", "state-only"]);
    }

    #[test]
    fn strips_accidental_prefix() {
        let content = "---\nname: x\ndescription: y\nflags: [--craft, --teach]\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.flags, vec!["craft", "teach"]);
    }

    #[test]
    fn parses_quoted_tokens() {
        let content = "---\nname: x\ndescription: y\nflags: [\"craft\", 'teach']\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert_eq!(fm.flags, vec!["craft", "teach"]);
    }

    #[test]
    fn missing_description_returns_none() {
        let content = "---\nname: foo\n---\n";
        assert!(parse_frontmatter(content).is_none());
    }

    #[test]
    fn missing_name_returns_none() {
        let content = "---\ndescription: some description\n---\n";
        assert!(parse_frontmatter(content).is_none());
    }

    #[test]
    fn override_true_detected() {
        let content =
            "---\nname: checkpoint\ndescription: local override\noverride: true\n---\n";
        let fm = parse_frontmatter(content).unwrap();
        assert!(fm.is_override);
    }

    #[test]
    fn skill_md_bak_would_be_ignored() {
        // SKILL.md.bak has extension "bak", not "md" — collect_commands skips it.
        // collect_skills only reads the exact filename SKILL.md, not siblings.
        // This test documents the expectation without filesystem access.
        let bak_content = "---\nname: gsd\ndescription: bak description\n---\n";
        // parse_frontmatter itself would succeed on valid content —
        // the protection is the filename check in collect_skills.
        assert!(parse_frontmatter(bak_content).is_some());
    }
}
