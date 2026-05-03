//! Built-in skills compiled into the helix binary.
//!
//! Unlike user / project skills which live on disk under `~/.claude/skills/`
//! or `<workspace>/.claude/skills/`, these ship inside the binary. Their
//! `SKILL.md` text is embedded via `include_str!` and parsed once on startup.
//! A user or project skill with the same `name` overrides the built-in
//! (precedence: project > user > builtin).
//!
//! To add a built-in: drop a `<name>.md` next to this file with valid Claude
//! Code frontmatter, then list it in `BUILTIN_SOURCES` below.

use crate::skills::{first_paragraph, parse_frontmatter, split_frontmatter};
use crate::types::{Skill, SkillSource};

/// Synthetic directory marker used for `Skill.directory` and
/// `Skill.skill_md_path`. Built-ins have no on-disk location, but the wire
/// format still requires both fields. The frontend recognises this prefix
/// and hides the "Path" detail row.
pub const BUILTIN_PATH_MARKER: &str = "<builtin>";

/// Each entry pairs a directory-style name (used for the slash command and
/// the `Skill.id`) with the embedded SKILL.md text.
struct BuiltinSource {
    dir_name: &'static str,
    skill_md: &'static str,
}

const BUILTIN_SOURCES: &[BuiltinSource] = &[BuiltinSource {
    dir_name: "writing-format-markdown",
    skill_md: include_str!("builtin_skills/writing-format-markdown.md"),
}];

/// Parse every embedded skill into a `Skill` record. Called once on startup
/// and every rescan; cheap (parsing happens against in-memory strings).
pub fn load() -> Vec<Skill> {
    BUILTIN_SOURCES
        .iter()
        .map(|src| parse_builtin(src))
        .collect()
}

fn parse_builtin(src: &BuiltinSource) -> Skill {
    let (front_raw, body) = split_frontmatter(src.skill_md);
    let fm = front_raw
        .and_then(|text| parse_frontmatter(text).ok())
        .unwrap_or_default();
    let name = fm
        .name
        .clone()
        .unwrap_or_else(|| src.dir_name.to_string());
    let description = fm.description.clone().or_else(|| first_paragraph(&body));
    Skill {
        id: format!("builtin::{}", src.dir_name),
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
        source: SkillSource::Builtin,
        directory: BUILTIN_PATH_MARKER.to_string(),
        skill_md_path: BUILTIN_PATH_MARKER.to_string(),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writing_format_markdown_loads() {
        let skills = load();
        let s = skills
            .iter()
            .find(|s| s.name == "writing-format-markdown")
            .expect("writing-format-markdown built-in not found");
        assert!(matches!(s.source, SkillSource::Builtin));
        assert_eq!(s.id, "builtin::writing-format-markdown");
        assert_eq!(s.directory, BUILTIN_PATH_MARKER);
        assert!(s.error.is_none());
        assert!(s.user_invocable);
        assert!(!s.body.is_empty());
        assert!(s.description.is_some());
    }
}
