//! Skills loader — Claude Desktop / Claude Code parity.
//!
//! A skill is a folder containing `SKILL.md` with optional YAML frontmatter
//! and a markdown body. Skills are discovered from two roots:
//!
//! - User: `~/.claude/skills/<skill-name>/SKILL.md`
//! - Project: `<workspace>/.claude/skills/<skill-name>/SKILL.md`
//!
//! When the same skill name appears in both, project overrides user (mirrors
//! Claude Code's precedence). The loader watches both directories and
//! re-scans on changes so edits / additions show up live.
//!
//! Frontmatter is parsed with a small parser that handles the subset Claude
//! uses: scalar strings, booleans, and either inline (`[a, b]`) or block
//! (`- a`) lists. That's intentionally narrow — pulling in a full YAML
//! dependency for ten well-known fields would be overkill.

use crate::types::{Skill, SkillFrontmatter, SkillSource};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Resolve `~/.claude/skills`. Returns `None` when the home dir is
/// unavailable (rare; happens in some sandboxed test environments).
pub fn user_skills_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))?;
    let path = PathBuf::from(home).join(".claude").join("skills");
    Some(path)
}

/// Resolve `<workspace>/.claude/skills` for a given workspace path.
pub fn project_skills_root(workspace: &Path) -> PathBuf {
    workspace.join(".claude").join("skills")
}

/// Walk a `<root>/<skill-name>/SKILL.md` layout and parse every entry. Skips
/// folders whose `SKILL.md` is missing or unreadable; surfaces parse errors
/// via `Skill.error` so the UI can render a "this skill is broken" row.
pub fn scan_root(root: &Path, source: SkillSource) -> Vec<Skill> {
    let mut out = Vec::new();
    let read = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let path = entry.path();
        let kind = entry.file_type().ok();
        if !kind.map(|k| k.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Skip dotfiles and the well-known noise dirs git might litter.
        if dir_name.starts_with('.') {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        match load_skill_file(&skill_md, &dir_name, source) {
            Ok(skill) => out.push(skill),
            Err(err) => out.push(broken_skill(&path, &dir_name, source, &err)),
        }
    }
    out
}

fn broken_skill(dir: &Path, dir_name: &str, source: SkillSource, err: &str) -> Skill {
    Skill {
        id: skill_id(source, dir_name),
        name: dir_name.to_string(),
        description: None,
        when_to_use: None,
        argument_hint: None,
        arguments: None,
        disable_model_invocation: false,
        user_invocable: true,
        allowed_tools: None,
        paths: None,
        body: String::new(),
        source,
        directory: dir.to_string_lossy().to_string(),
        skill_md_path: dir.join("SKILL.md").to_string_lossy().to_string(),
        error: Some(err.to_string()),
    }
}

/// Parse a single `SKILL.md` file into a `Skill`. Returns `Err(reason)` if
/// the file can't be read or the frontmatter is malformed.
fn load_skill_file(path: &Path, dir_name: &str, source: SkillSource) -> Result<Skill, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;
    let (front_raw, body) = split_frontmatter(&raw);
    let fm = if let Some(text) = front_raw {
        parse_frontmatter(text)?
    } else {
        SkillFrontmatter::default()
    };

    // Per Claude Code: name defaults to the directory name, description
    // defaults to the first paragraph of the body. Both are optional in the
    // file itself.
    let name = fm
        .name
        .clone()
        .unwrap_or_else(|| dir_name.to_string());
    let description = fm
        .description
        .clone()
        .or_else(|| first_paragraph(&body));

    Ok(Skill {
        id: skill_id(source, dir_name),
        name,
        description,
        when_to_use: fm.when_to_use,
        argument_hint: fm.argument_hint,
        arguments: fm.arguments,
        disable_model_invocation: fm.disable_model_invocation.unwrap_or(false),
        user_invocable: fm.user_invocable.unwrap_or(true),
        allowed_tools: fm.allowed_tools,
        paths: fm.paths,
        body,
        source,
        directory: path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        skill_md_path: path.to_string_lossy().to_string(),
        error: None,
    })
}

fn skill_id(source: SkillSource, dir_name: &str) -> String {
    let prefix = match source {
        SkillSource::Builtin => "builtin",
        SkillSource::User => "user",
        SkillSource::Project => "project",
    };
    format!("{prefix}::{dir_name}")
}

/// Split `raw` into `(frontmatter, body)`. Frontmatter must start at the
/// very first byte of the file (optionally after a UTF-8 BOM) and is fenced
/// by `---` lines, matching Claude's spec.
pub fn split_frontmatter(raw: &str) -> (Option<&str>, String) {
    let stripped = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let trimmed_start = stripped.trim_start_matches(['\n', '\r']);
    let opens_with_dashes = trimmed_start.starts_with("---");
    if !opens_with_dashes {
        return (None, raw.to_string());
    }
    let after_open = &trimmed_start[3..];
    // The opening delimiter line ends at the next newline.
    let nl = match after_open.find('\n') {
        Some(i) => i,
        None => return (None, raw.to_string()),
    };
    // Anything else on the open line (besides whitespace) means it isn't
    // really a frontmatter delimiter.
    if !after_open[..nl].trim().is_empty() {
        return (None, raw.to_string());
    }
    let rest = &after_open[nl + 1..];
    // Find a closing line that is exactly `---` (optional whitespace).
    let mut idx = 0usize;
    let bytes = rest.as_bytes();
    let mut closing: Option<(usize, usize)> = None; // (line_start, line_end_excl_newline)
    while idx < bytes.len() {
        let line_start = idx;
        let line_end = match rest[line_start..].find('\n') {
            Some(off) => line_start + off,
            None => bytes.len(),
        };
        let line = &rest[line_start..line_end];
        if line.trim() == "---" {
            closing = Some((line_start, line_end));
            break;
        }
        idx = if line_end < bytes.len() {
            line_end + 1
        } else {
            line_end
        };
    }
    let Some((close_start, close_end)) = closing else {
        return (None, raw.to_string());
    };
    let front = &rest[..close_start];
    let after_close = if close_end < rest.len() {
        // Skip the newline after `---` if any.
        let next = close_end;
        if rest.as_bytes().get(next) == Some(&b'\n') {
            &rest[next + 1..]
        } else {
            &rest[next..]
        }
    } else {
        ""
    };
    (Some(front), after_close.to_string())
}

/// Parse the limited YAML subset used by SKILL.md frontmatter. Supports:
/// - `key: value` (string scalar, optionally single/double-quoted)
/// - `key: true|false` (boolean)
/// - `key: [a, b, c]` (inline list)
/// - `key:\n  - a\n  - b` (block list)
/// - `# comment` lines (skipped)
///
/// Anything more exotic returns an error so the user sees a clear "couldn't
/// parse frontmatter" hint rather than silent misbehaviour.
pub fn parse_frontmatter(text: &str) -> Result<SkillFrontmatter, String> {
    let mut fm = SkillFrontmatter::default();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let raw_line = lines[i];
        let line = raw_line.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            i += 1;
            continue;
        }
        // Top-level key lines have no leading whitespace.
        if line.starts_with(|c: char| c.is_whitespace()) {
            return Err(format!("unexpected indentation: {line:?}"));
        }
        let colon = line
            .find(':')
            .ok_or_else(|| format!("expected `key: value`: {line:?}"))?;
        let key = line[..colon].trim().to_lowercase();
        let value = line[colon + 1..].trim();

        // Block list — value empty, following lines are `- item` indented.
        if value.is_empty() {
            let mut items = Vec::new();
            i += 1;
            while i < lines.len() {
                let next = lines[i];
                let trimmed = next.trim_start();
                if !next.starts_with(|c: char| c.is_whitespace())
                    && !trimmed.is_empty()
                {
                    break;
                }
                if trimmed.is_empty() {
                    i += 1;
                    continue;
                }
                let item = trimmed
                    .strip_prefix('-')
                    .ok_or_else(|| {
                        format!("expected `- item` under `{key}`, got {trimmed:?}")
                    })?
                    .trim();
                items.push(strip_quotes(item).to_string());
                i += 1;
            }
            apply_list_field(&mut fm, &key, items);
            continue;
        }

        // Inline list — `[a, b, c]`.
        if value.starts_with('[') && value.ends_with(']') {
            let inner = &value[1..value.len() - 1];
            let items: Vec<String> = inner
                .split(',')
                .map(|s| strip_quotes(s.trim()).to_string())
                .filter(|s| !s.is_empty())
                .collect();
            apply_list_field(&mut fm, &key, items);
            i += 1;
            continue;
        }

        // Scalar.
        let unquoted = strip_quotes(value).to_string();
        apply_scalar_field(&mut fm, &key, unquoted);
        i += 1;
    }
    Ok(fm)
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Split a space- or comma-separated string into a list. Mirrors how Claude
/// Code accepts `allowed-tools: Read Grep` or `allowed-tools: Read, Grep`.
fn split_compact_list(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c.is_whitespace())
        .map(|p| strip_quotes(p.trim()).to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn apply_scalar_field(fm: &mut SkillFrontmatter, key: &str, value: String) {
    match key {
        "name" => fm.name = Some(value),
        "description" => fm.description = Some(value),
        "when_to_use" | "when-to-use" => fm.when_to_use = Some(value),
        "argument-hint" | "argument_hint" => fm.argument_hint = Some(value),
        "arguments" => fm.arguments = Some(split_compact_list(&value)),
        "disable-model-invocation" | "disable_model_invocation" => {
            fm.disable_model_invocation = parse_bool(&value);
        }
        "user-invocable" | "user_invocable" => {
            fm.user_invocable = parse_bool(&value);
        }
        "allowed-tools" | "allowed_tools" => {
            fm.allowed_tools = Some(split_compact_list(&value));
        }
        "paths" => fm.paths = Some(split_compact_list(&value)),
        // Unknown keys are tolerated — Claude Code adds new ones over time
        // (model, effort, hooks, etc.) and we don't want to break loading.
        _ => {}
    }
}

fn apply_list_field(fm: &mut SkillFrontmatter, key: &str, items: Vec<String>) {
    match key {
        "arguments" => fm.arguments = Some(items),
        "allowed-tools" | "allowed_tools" => fm.allowed_tools = Some(items),
        "paths" => fm.paths = Some(items),
        _ => {}
    }
}

pub fn first_paragraph(body: &str) -> Option<String> {
    let trimmed = body.trim_start();
    if trimmed.is_empty() {
        return None;
    }
    let para = trimmed.split("\n\n").next().unwrap_or(trimmed);
    let cleaned = para
        .lines()
        .map(|l| l.trim_start_matches('#').trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Substitute Claude Code's argument placeholders inside a SKILL.md body.
/// Implements the parity-relevant slice: `$ARGUMENTS`, `$ARGUMENTS[N]`,
/// `$N` shorthand, and named placeholders declared in `arguments`. Falls
/// back to appending `ARGUMENTS: <raw>` when the body never references the
/// passed input — same as Claude Code's behaviour.
pub fn substitute_arguments(body: &str, args_raw: &str, named: &[String]) -> String {
    let parsed = shell_split(args_raw);
    let mut result = String::with_capacity(body.len() + args_raw.len());
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut used_anything = false;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() {
            // $ARGUMENTS or $ARGUMENTS[N]
            if body[i + 1..].starts_with("ARGUMENTS") {
                let after = i + 1 + "ARGUMENTS".len();
                // Optional `[N]` index.
                if body[after..].starts_with('[') {
                    if let Some(close) = body[after + 1..].find(']') {
                        let idx_str = &body[after + 1..after + 1 + close];
                        if let Ok(n) = idx_str.trim().parse::<usize>() {
                            let val = parsed.get(n).cloned().unwrap_or_default();
                            result.push_str(&val);
                            used_anything = true;
                            i = after + 1 + close + 1;
                            continue;
                        }
                    }
                }
                result.push_str(args_raw);
                used_anything = true;
                i = after;
                continue;
            }
            // $N shorthand (numeric).
            let rest = &body[i + 1..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() {
                if let Ok(n) = digits.parse::<usize>() {
                    let val = parsed.get(n).cloned().unwrap_or_default();
                    result.push_str(&val);
                    used_anything = true;
                    i += 1 + digits.len();
                    continue;
                }
            }
            // $name — match against the declared named arguments.
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !name.is_empty() {
                if let Some(idx) = named.iter().position(|n| n == &name) {
                    let val = parsed.get(idx).cloned().unwrap_or_default();
                    result.push_str(&val);
                    used_anything = true;
                    i += 1 + name.len();
                    continue;
                }
            }
        }
        let ch = body[i..].chars().next().unwrap();
        result.push(ch);
        i += ch.len_utf8();
    }
    if !used_anything && !args_raw.trim().is_empty() {
        if !result.ends_with('\n') {
            result.push('\n');
        }
        result.push_str("\nARGUMENTS: ");
        result.push_str(args_raw);
    }
    result
}

/// Tokenise a string the same way Claude Code does for `$ARGUMENTS[N]`:
/// shell-style with quote handling. Multi-word values pass through as a
/// single token when wrapped in matching quotes.
fn shell_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;
    for ch in s.chars() {
        if in_double {
            if ch == '"' {
                in_double = false;
            } else {
                current.push(ch);
            }
        } else if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                current.push(ch);
            }
        } else if ch == '"' {
            in_double = true;
        } else if ch == '\'' {
            in_single = true;
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

// -- Manager ----------------------------------------------------------------

/// Tracks the currently-loaded set of skills and the watchers that keep them
/// fresh. Mirrors `McpManager` in spirit — lib.rs creates one, registers it
/// with Tauri, and supplies a callback to refresh state on change.
pub struct SkillsManager {
    inner: Mutex<Inner>,
    on_change: Box<dyn Fn(Vec<Skill>) + Send + Sync>,
}

struct Inner {
    /// Currently-tracked workspace root (resolves to `<root>/.claude/skills`).
    workspace_root: Option<PathBuf>,
    /// Active watchers — keep them alive in a HashMap so dropping them
    /// when re-watching releases the OS handles deterministically.
    watchers: HashMap<&'static str, RecommendedWatcher>,
}

impl SkillsManager {
    pub fn new<F>(on_change: F) -> Arc<Self>
    where
        F: Fn(Vec<Skill>) + Send + Sync + 'static,
    {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                workspace_root: None,
                watchers: HashMap::new(),
            }),
            on_change: Box::new(on_change),
        })
    }

    /// Re-scan all roots and emit the merged list. Project entries override
    /// user entries with the same directory name — matches Claude Code's
    /// precedence (project > personal).
    pub fn rescan(&self) {
        let workspace_root = {
            let guard = self.inner.lock().expect("skills inner poisoned");
            guard.workspace_root.clone()
        };
        let skills = scan_all(workspace_root.as_deref());
        (self.on_change)(skills);
    }

    /// Switch the active workspace root being watched. Passing `None` stops
    /// project-scoped watching entirely. Always triggers a rescan, even when
    /// the path doesn't change, so callers can use this to force a refresh.
    pub fn set_workspace(self: &Arc<Self>, workspace: Option<PathBuf>) {
        {
            let mut guard = self.inner.lock().expect("skills inner poisoned");
            guard.workspace_root = workspace.clone();
            guard.watchers.remove("project");
        }
        if let Some(root) = workspace {
            self.spawn_watcher("project", project_skills_root(&root));
        }
        self.rescan();
    }

    /// Install the per-user watcher. Idempotent.
    pub fn watch_user_root(self: &Arc<Self>) {
        if let Some(user) = user_skills_root() {
            self.spawn_watcher("user", user);
        }
    }

    fn spawn_watcher(self: &Arc<Self>, slot: &'static str, target_dir: PathBuf) {
        // Watch the parent of `<root>/.claude/skills` if the target itself
        // doesn't exist yet — otherwise the user creating the directory
        // wouldn't trigger any event. Walk up until we find an existing
        // ancestor.
        let watch_dir = {
            let mut current = target_dir.clone();
            loop {
                if current.exists() {
                    break current;
                }
                match current.parent() {
                    Some(parent) => current = parent.to_path_buf(),
                    None => return,
                }
            }
        };

        let me = Arc::clone(self);
        let mut watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                if res.is_ok() {
                    // Coalesce bursts — the OS may emit a flurry of events
                    // for one save. A short sleep before rescanning lets
                    // them settle without us reading half-written files.
                    std::thread::sleep(Duration::from_millis(80));
                    me.rescan();
                }
            },
        ) {
            Ok(w) => w,
            Err(err) => {
                log::warn!("[skills] failed to create watcher for {slot}: {err}");
                return;
            }
        };
        if let Err(err) = watcher.watch(&watch_dir, RecursiveMode::Recursive) {
            log::warn!(
                "[skills] failed to watch {}: {err}",
                watch_dir.display()
            );
            return;
        }
        let mut guard = self.inner.lock().expect("skills inner poisoned");
        guard.watchers.insert(slot, watcher);
    }
}

/// Merge built-in + user + project scans. Precedence on name collision is
/// project > user > builtin: the lower-tier copy is dropped entirely so the
/// UI doesn't render duplicates.
pub fn scan_all(workspace: Option<&Path>) -> Vec<Skill> {
    let mut builtin_skills = crate::builtin_skills::load();
    let mut user_skills = match user_skills_root() {
        Some(root) => scan_root(&root, SkillSource::User),
        None => Vec::new(),
    };
    let project_skills = match workspace {
        Some(ws) => scan_root(&project_skills_root(ws), SkillSource::Project),
        None => Vec::new(),
    };

    if !project_skills.is_empty() {
        let project_names: std::collections::HashSet<&str> = project_skills
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        user_skills.retain(|s| !project_names.contains(s.name.as_str()));
        builtin_skills.retain(|s| !project_names.contains(s.name.as_str()));
    }
    if !user_skills.is_empty() {
        let user_names: std::collections::HashSet<&str> =
            user_skills.iter().map(|s| s.name.as_str()).collect();
        builtin_skills.retain(|s| !user_names.contains(s.name.as_str()));
    }

    let mut out = Vec::with_capacity(
        builtin_skills.len() + user_skills.len() + project_skills.len(),
    );
    out.extend(builtin_skills);
    out.extend(user_skills);
    out.extend(project_skills);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_frontmatter() {
        let raw = "---\nname: foo\ndescription: does foo\n---\nbody";
        let (front, body) = split_frontmatter(raw);
        assert_eq!(front, Some("name: foo\ndescription: does foo\n"));
        assert_eq!(body, "body");
        let fm = parse_frontmatter(front.unwrap()).unwrap();
        assert_eq!(fm.name.as_deref(), Some("foo"));
        assert_eq!(fm.description.as_deref(), Some("does foo"));
    }

    #[test]
    fn parses_block_list() {
        let raw = "allowed-tools:\n  - Read\n  - Grep\n";
        let fm = parse_frontmatter(raw).unwrap();
        assert_eq!(
            fm.allowed_tools.as_deref(),
            Some(&["Read".to_string(), "Grep".to_string()][..])
        );
    }

    #[test]
    fn parses_inline_list_and_bool() {
        let raw = "paths: [src/**/*.ts, tests/**/*.ts]\ndisable-model-invocation: true\n";
        let fm = parse_frontmatter(raw).unwrap();
        assert_eq!(fm.disable_model_invocation, Some(true));
        assert_eq!(
            fm.paths.as_deref(),
            Some(
                &[
                    "src/**/*.ts".to_string(),
                    "tests/**/*.ts".to_string()
                ][..]
            )
        );
    }

    #[test]
    fn substitutes_dollar_arguments() {
        let body = "Fix $ARGUMENTS now.";
        assert_eq!(
            substitute_arguments(body, "issue-1 urgent", &[]),
            "Fix issue-1 urgent now."
        );
    }

    #[test]
    fn substitutes_indexed_arguments() {
        let body = "Migrate $0 from $1 to $2.";
        assert_eq!(
            substitute_arguments(body, "SearchBar React Vue", &[]),
            "Migrate SearchBar from React to Vue."
        );
    }

    #[test]
    fn appends_arguments_when_unused() {
        let body = "Do something.";
        let out = substitute_arguments(body, "abc", &[]);
        assert!(out.contains("Do something."));
        assert!(out.contains("ARGUMENTS: abc"));
    }
}
