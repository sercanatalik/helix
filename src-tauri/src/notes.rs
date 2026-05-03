//! Workspace markdown notes.
//!
//! Notes are plain `.md` files living anywhere inside an attached workspace
//! folder. The filesystem is the source of truth — `NoteRecord` is just an
//! index the UI reads to render the sidebar list. The frontend keeps an
//! "active note id" of its own; we only deal with disk + scan + write.
//!
//! Scanning rules mirror `commands::list_workspace_tree`: same noise filter,
//! same depth cap, but only `.md` files. Hidden directories (anything that
//! starts with `.`) are skipped so `~/notes/.git/` doesn't poison the list.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DEPTH: u32 = 8;
const MAX_NOTES: usize = 5000;
const SNIPPET_CHARS: usize = 140;

/// One markdown file inside a workspace. `id` is a stable hash of the
/// absolute path so the frontend can keep the active selection across rescans
/// even when the underlying record gets replaced.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub workspace_id: String,
    /// Absolute path on disk. The frontend treats this as opaque.
    pub path: String,
    /// Path relative to the workspace root, forward-slash separated.
    pub relative_path: String,
    /// Display title — derived from the first H1 if present, otherwise the
    /// filename without extension.
    pub title: String,
    /// First few lines of body text after stripping the H1 line. Truncated
    /// to `SNIPPET_CHARS` chars at a word boundary.
    pub snippet: String,
    /// File mtime as ISO-8601. Used for sorting + collision detection
    /// across multiple windows.
    pub modified_at: String,
}

/// Folders we skip for the same reason `list_workspace_tree` does — heavy or
/// generated, and unlikely to hold notes the user authored.
fn is_noise_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".svn"
            | ".hg"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".idea"
            | ".vscode"
            | "__pycache__"
            | ".venv"
            | "venv"
            | ".pytest_cache"
            | ".mypy_cache"
    ) || (name.starts_with('.') && name.len() > 1)
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Stable id derived from the absolute path. Hash is deterministic across
/// runs so the frontend's `activeNoteId` survives a relaunch. Uses the
/// stdlib hasher because we don't need cryptographic strength here.
fn note_id_for(workspace_id: &str, path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    workspace_id.hash(&mut hasher);
    path.to_string_lossy().hash(&mut hasher);
    format!("note_{:016x}", hasher.finish())
}

fn iso_from_system_time(t: SystemTime) -> String {
    let dur = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = dur.as_secs() as i64;
    // Use the `time` crate already pulled in by Cargo.toml for ISO-8601.
    let offset = time::OffsetDateTime::from_unix_timestamp(secs)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    offset
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| String::new())
}

/// Strip leading whitespace + `#` markers to derive the title from a markdown
/// H1 line. Returns `None` if the line isn't an H1.
fn h1_text(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("# ") && trimmed != "#" {
        return None;
    }
    let rest = trimmed.trim_start_matches('#').trim();
    if rest.is_empty() { None } else { Some(rest.to_string()) }
}

/// Pull the title (first H1 or filename) and a body snippet from raw markdown.
pub fn derive_title_and_snippet(content: &str, fallback_filename: &str) -> (String, String) {
    let mut title: Option<String> = None;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in content.lines() {
        if title.is_none() {
            if let Some(t) = h1_text(line) {
                title = Some(t);
                continue;
            }
        }
        body_lines.push(line);
    }
    let title = title.unwrap_or_else(|| {
        // Drop extension from filename.
        let stem = Path::new(fallback_filename)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| fallback_filename.to_string());
        if stem.is_empty() {
            "Untitled".to_string()
        } else {
            stem
        }
    });
    let mut snippet = String::new();
    for line in body_lines {
        let t = line.trim();
        if t.is_empty() {
            if !snippet.is_empty() {
                snippet.push(' ');
            }
            continue;
        }
        if !snippet.is_empty() {
            snippet.push(' ');
        }
        snippet.push_str(t);
        if snippet.len() >= SNIPPET_CHARS {
            break;
        }
    }
    let snippet = if snippet.len() > SNIPPET_CHARS {
        let mut cut = SNIPPET_CHARS;
        while !snippet.is_char_boundary(cut) && cut > 0 {
            cut -= 1;
        }
        format!("{}…", &snippet[..cut])
    } else {
        snippet
    };
    (title, snippet)
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn walk(workspace_id: &str, root: &Path, dir: &Path, depth: u32, out: &mut Vec<NoteRecord>) {
    if depth > MAX_DEPTH || out.len() >= MAX_NOTES {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = entry.file_type().ok();
        let path = entry.path();
        if kind.map(|k| k.is_dir()).unwrap_or(false) {
            if is_noise_dir(&name) {
                continue;
            }
            subdirs.push(path);
        } else if kind.map(|k| k.is_file()).unwrap_or(false) {
            if !is_markdown(&name) {
                continue;
            }
            files.push(path);
        }
    }
    subdirs.sort();
    files.sort();

    for path in files {
        if out.len() >= MAX_NOTES {
            return;
        }
        if let Some(rec) = build_record(workspace_id, root, &path) {
            out.push(rec);
        }
    }
    for sub in subdirs {
        walk(workspace_id, root, &sub, depth + 1, out);
    }
}

/// Build a `NoteRecord` for a single file. Public so detached note windows
/// can resolve the record they were opened against without paying for a
/// full workspace scan.
pub fn record_for_path(workspace_id: &str, root: &Path, path: &Path) -> Option<NoteRecord> {
    build_record(workspace_id, root, path)
}

fn build_record(workspace_id: &str, root: &Path, path: &Path) -> Option<NoteRecord> {
    let meta = fs::metadata(path).ok()?;
    let modified_at = meta
        .modified()
        .ok()
        .map(iso_from_system_time)
        .unwrap_or_default();
    // Read the first ~4 KB to derive the title + snippet without slurping
    // multi-MB files. Anything past that almost never affects either.
    let head = read_head(path, 4096).unwrap_or_default();
    let filename = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let (title, snippet) = derive_title_and_snippet(&head, &filename);
    Some(NoteRecord {
        id: note_id_for(workspace_id, path),
        workspace_id: workspace_id.to_string(),
        path: path.to_string_lossy().to_string(),
        relative_path: relative_to(root, path),
        title,
        snippet,
        modified_at,
    })
}

fn read_head(path: &Path, max_bytes: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; max_bytes];
    let n = file.read(&mut buf)?;
    buf.truncate(n);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Scan `root` for markdown files and return them sorted by mtime descending
/// (newest first) so the sidebar shows recently-touched notes at the top.
pub fn scan_workspace(workspace_id: &str, root: &Path) -> Vec<NoteRecord> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out: Vec<NoteRecord> = Vec::new();
    walk(workspace_id, root, root, 0, &mut out);
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out
}

/// Read a note's full body off disk. Hard-capped at 5 MB so a runaway file
/// can't OOM the renderer round-trip.
pub fn read_note_content(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    let meta = fs::metadata(path)?;
    if meta.len() > MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("note too large to edit: {} bytes", meta.len()),
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut s = String::new();
    file.read_to_string(&mut s)?;
    Ok(s)
}

/// Write a note's body to disk. Creates parent dirs on demand and refreshes
/// the returned record so the caller doesn't have to follow up with a scan.
pub fn write_note_content(workspace_id: &str, root: &Path, path: &Path, content: &str)
    -> std::io::Result<NoteRecord>
{
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(path, content)?;
    build_record(workspace_id, root, path).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::Other,
            "failed to rebuild note record after write",
        )
    })
}

/// Pick a fresh `untitled-N.md` path under `root` that doesn't collide with
/// an existing file. Counts up until it finds an opening; capped at 9999 so
/// pathological cases fail fast instead of looping forever.
pub fn next_untitled_path(root: &Path) -> Option<PathBuf> {
    for n in 1..=9999u32 {
        let candidate = root.join(format!("untitled-{n}.md"));
        if !candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Slugify a free-form title into a filesystem-safe stem. Lowercases, keeps
/// alphanumerics + hyphens, collapses everything else into single hyphens.
fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        // Filesystems don't love arbitrarily long names. 64 chars is plenty
        // and matches the slug length most blogs settle on.
        if trimmed.len() > 64 {
            let mut cut = 64;
            while !trimmed.is_char_boundary(cut) && cut > 0 {
                cut -= 1;
            }
            trimmed[..cut].to_string()
        } else {
            trimmed
        }
    }
}

/// Pick a non-colliding file path for `<root>/<slug>.md`. Appends `-2`, `-3`,
/// … if the base slug is taken so renaming "Notes" twice doesn't blow away
/// the first one.
pub fn unique_path_for_title(root: &Path, title: &str) -> PathBuf {
    let stem = slugify(title);
    let base = root.join(format!("{stem}.md"));
    if !base.exists() {
        return base;
    }
    for n in 2..=999u32 {
        let candidate = root.join(format!("{stem}-{n}.md"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Fallback — should be unreachable in practice.
    root.join(format!("{stem}-{}.md", uuid::Uuid::new_v4().simple()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_title_from_first_h1() {
        let (title, snippet) = derive_title_and_snippet(
            "# Hello world\n\nSome body text here.",
            "untitled-1.md",
        );
        assert_eq!(title, "Hello world");
        assert_eq!(snippet, "Some body text here.");
    }

    #[test]
    fn falls_back_to_filename_without_h1() {
        let (title, _) = derive_title_and_snippet("just body, no heading", "my-note.md");
        assert_eq!(title, "my-note");
    }

    #[test]
    fn slugify_handles_punctuation() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  --  spaces  --  "), "spaces");
        assert_eq!(slugify(""), "untitled");
    }
}
