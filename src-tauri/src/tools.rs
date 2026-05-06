//! Built-in file & code-operation tools — Read, Write, Edit, Glob, Grep.
//!
//! These mirror the canonical Claude-Code tool set so an MCP-less helix
//! session still has first-class filesystem access. Each function is wired
//! up as a Tauri command in `lib.rs`; the tool surface is symmetric with
//! `helixApi` on the renderer side.
//!
//! Design notes:
//! - Paths are accepted verbatim. We intentionally don't sandbox to a
//!   workspace because helix is a local-first desktop app — the user is
//!   running it against their own filesystem and the same paths their
//!   shell would resolve.
//! - All errors come back as `Result<_, String>` so they surface as a
//!   readable rejection in the renderer's `invoke` promise rather than a
//!   panic over the bridge.
//! - Output shapes are JSON-serializable structs with `camelCase` field
//!   names so the TypeScript bridge in `lib/tauri-api.ts` can declare them
//!   without intermediate translation.

use crate::tool_progress;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;
use tauri::AppHandle;

// -- Read ----------------------------------------------------------------

/// Hard cap on bytes returned per text read — defends against accidental
/// reads of multi-GB files and matches Claude Code's "first ~2000 lines"
/// default. Callers can tune the visible window with `offset`/`limit`.
const READ_DEFAULT_LIMIT: usize = 2000;
const READ_MAX_LINE_BYTES: usize = 2000;
/// Soft cap on the total bytes returned for binary reads (image/pdf). The
/// data crosses the Tauri IPC boundary as base64, so an unbounded read can
/// cause a noticeable freeze. 10 MB is comfortable for everyday assets.
const READ_BINARY_MAX_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    /// Discriminator for how to render this payload — text body vs binary
    /// data URL vs notebook source bundle.
    pub kind: ReadKind,
    /// For `text` and `notebook`: the (possibly windowed) UTF-8 body. For
    /// `image` / `pdf`: a base64 data URL.
    pub content: String,
    /// Total line count of the underlying file when known. Lets the
    /// renderer paginate without re-reading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<u64>,
    /// Detected MIME type for non-text reads. Empty for plain text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// File size in bytes.
    pub size: u64,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ReadKind {
    Text,
    Image,
    Pdf,
    Notebook,
}

#[tauri::command]
pub fn read_file(
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<ReadResult, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("read_file: {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("read_file: not a regular file: {path}"));
    }
    let size = meta.len();

    match classify(&p) {
        ReadKind::Image => read_binary(&p, size, image_mime_for(&p), ReadKind::Image),
        ReadKind::Pdf => read_binary(&p, size, "application/pdf", ReadKind::Pdf),
        ReadKind::Notebook => read_notebook(&p, size),
        ReadKind::Text => read_text(&p, size, offset, limit),
    }
}

fn classify(path: &Path) -> ReadKind {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" => ReadKind::Image,
        "pdf" => ReadKind::Pdf,
        "ipynb" => ReadKind::Notebook,
        _ => ReadKind::Text,
    }
}

fn image_mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn read_binary(
    path: &Path,
    size: u64,
    mime: &str,
    kind: ReadKind,
) -> Result<ReadResult, String> {
    if size > READ_BINARY_MAX_BYTES {
        return Err(format!(
            "read_file: binary file too large ({size} bytes, max {READ_BINARY_MAX_BYTES})"
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("read_file: {e}"))?;
    let encoded = B64.encode(&bytes);
    let data_url = format!("data:{mime};base64,{encoded}");
    Ok(ReadResult {
        kind,
        content: data_url,
        total_lines: None,
        mime_type: Some(mime.to_string()),
        size,
    })
}

fn read_text(
    path: &Path,
    size: u64,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<ReadResult, String> {
    let raw = fs::read(path).map_err(|e| format!("read_file: {e}"))?;
    let body = String::from_utf8_lossy(&raw);

    // Walk the body line-by-line so callers can window into a long file
    // without us materializing the whole vec. Truncate any line wider than
    // READ_MAX_LINE_BYTES — minified bundles can blow up the renderer.
    let mut lines: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for line in body.split('\n') {
        total += 1;
        if line.len() > READ_MAX_LINE_BYTES {
            let mut t = line[..READ_MAX_LINE_BYTES].to_string();
            t.push_str("…[truncated]");
            lines.push(t);
        } else {
            lines.push(line.to_string());
        }
    }
    // `split('\n')` on a body that ends with a newline produces an empty
    // trailing entry — drop it so the line count matches what the user
    // sees in their editor.
    if matches!(lines.last(), Some(s) if s.is_empty()) && body.ends_with('\n') {
        lines.pop();
        total = total.saturating_sub(1);
    }

    let start = offset.unwrap_or(0) as usize;
    let take = limit.unwrap_or(READ_DEFAULT_LIMIT as u64) as usize;
    let slice: Vec<String> = lines
        .into_iter()
        .skip(start)
        .take(take.max(1))
        .enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect();

    Ok(ReadResult {
        kind: ReadKind::Text,
        content: slice.join("\n"),
        total_lines: Some(total),
        mime_type: None,
        size,
    })
}

fn read_notebook(path: &Path, size: u64) -> Result<ReadResult, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read_file: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("read_file: invalid .ipynb: {e}"))?;
    let cells = v
        .get("cells")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    // Concatenate cell sources with markers so the model can tell where one
    // cell ends and the next begins. Outputs (images, stream text) are
    // dropped — they often dominate notebook JSON without contributing to
    // what the user actually wrote.
    let mut buf = String::new();
    for (idx, cell) in cells.iter().enumerate() {
        let cell_type = cell
            .get("cell_type")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");
        let src = cell.get("source").map(stringify_source).unwrap_or_default();
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(&format!("# --- cell {idx} [{cell_type}] ---\n"));
        buf.push_str(&src);
        if !src.ends_with('\n') {
            buf.push('\n');
        }
    }
    Ok(ReadResult {
        kind: ReadKind::Notebook,
        content: buf,
        total_lines: None,
        mime_type: Some("application/x-ipynb+json".to_string()),
        size,
    })
}

/// Notebook `source` may be either a single string or an array of strings —
/// flatten either shape into one string.
fn stringify_source(v: &serde_json::Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

// -- Write ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub bytes_written: u64,
    /// True when the write created the file. False when it overwrote an
    /// existing file.
    pub created: bool,
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<WriteResult, String> {
    let p = PathBuf::from(&path);
    let created = !p.exists();
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("write_file: create_dir_all {parent:?}: {e}"))?;
        }
    }
    let bytes = content.as_bytes();
    let mut f = fs::File::create(&p).map_err(|e| format!("write_file: {path}: {e}"))?;
    f.write_all(bytes)
        .map_err(|e| format!("write_file: {path}: {e}"))?;
    f.flush().map_err(|e| format!("write_file: {path}: {e}"))?;
    Ok(WriteResult {
        path,
        bytes_written: bytes.len() as u64,
        created,
    })
}

// -- Edit ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    pub path: String,
    pub replacements: u32,
}

#[tauri::command]
pub fn edit_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<EditResult, String> {
    if old_string.is_empty() {
        return Err("edit_file: old_string is empty — would match every position".to_string());
    }
    if old_string == new_string {
        return Err("edit_file: old_string and new_string are identical".to_string());
    }
    let p = PathBuf::from(&path);
    let original = fs::read_to_string(&p).map_err(|e| format!("edit_file: {path}: {e}"))?;

    let replace_all = replace_all.unwrap_or(false);
    let occurrences = count_occurrences(&original, &old_string);
    if occurrences == 0 {
        return Err(format!("edit_file: old_string not found in {path}"));
    }
    if !replace_all && occurrences > 1 {
        return Err(format!(
            "edit_file: old_string matched {occurrences} places in {path}; pass replaceAll=true or supply a unique excerpt"
        ));
    }

    let updated = if replace_all {
        original.replace(&old_string, &new_string)
    } else {
        // Single replacement — replacen with limit 1 keeps the first match
        // intact (callers expect exactly one swap).
        original.replacen(&old_string, &new_string, 1)
    };

    fs::write(&p, &updated).map_err(|e| format!("edit_file: {path}: {e}"))?;

    let replacements = if replace_all { occurrences } else { 1 };
    Ok(EditResult {
        path,
        replacements,
    })
}

fn count_occurrences(haystack: &str, needle: &str) -> u32 {
    if needle.is_empty() {
        return 0;
    }
    let mut count: u32 = 0;
    let mut start = 0;
    while let Some(idx) = haystack[start..].find(needle) {
        count += 1;
        start += idx + needle.len();
    }
    count
}

// -- Glob ----------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobMatch {
    pub path: String,
    /// Last-modified time as Unix-epoch milliseconds, when the OS exposes
    /// it. Used by callers that want recently-touched files first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<i64>,
}

const GLOB_MAX_MATCHES: usize = 5000;

#[tauri::command]
pub fn glob_files(
    pattern: String,
    cwd: Option<String>,
) -> Result<Vec<GlobMatch>, String> {
    // Patterns are interpreted relative to `cwd` when provided. The `glob`
    // crate doesn't take a working directory, so we join manually and
    // normalize on the way out.
    let base = cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let resolved = if Path::new(&pattern).is_absolute() {
        pattern.clone()
    } else {
        base.join(&pattern).to_string_lossy().to_string()
    };

    let mut out: Vec<GlobMatch> = Vec::new();
    let entries =
        glob::glob(&resolved).map_err(|e| format!("glob_files: invalid pattern: {e}"))?;
    for entry in entries {
        if out.len() >= GLOB_MAX_MATCHES {
            break;
        }
        let p = match entry {
            Ok(p) => p,
            Err(_) => continue, // unreadable entry — skip
        };
        if !p.is_file() {
            continue;
        }
        let modified_ms = fs::metadata(&p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| system_time_to_ms(t));
        out.push(GlobMatch {
            path: p.to_string_lossy().to_string(),
            modified_ms,
        });
    }
    // Newest first — matches Claude Code's "Glob returns matches sorted by
    // modification time" so callers iterating recent edits hit them up top.
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

fn system_time_to_ms(t: SystemTime) -> Option<i64> {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

// -- Grep ----------------------------------------------------------------

#[derive(Debug, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum GrepMode {
    /// Bare list of files that contain at least one match. Cheap — stops
    /// at the first hit per file.
    #[default]
    Files,
    /// Per-line matches (path:line:text). Good for browsing.
    Content,
    /// Match counts per file — useful for prioritizing where to look.
    Count,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrepArgs {
    /// Regex pattern. Always compiled with `regex`'s default flavour;
    /// callers can prepend `(?i)` etc. for inline flags.
    pub pattern: String,
    /// Search root. Defaults to the process CWD.
    #[serde(default)]
    pub path: Option<String>,
    /// Glob restricting which files to search. Matches Claude Code's
    /// `glob` parameter — e.g. `**/*.{ts,tsx}`. Empty = all files.
    #[serde(default)]
    pub glob: Option<String>,
    /// `files`, `content`, or `count`. Defaults to `files`.
    #[serde(default)]
    pub mode: GrepMode,
    /// Case-insensitive matching. Equivalent to prepending `(?i)`.
    #[serde(default)]
    pub case_insensitive: bool,
    /// Lines of context to emit before/after each match in `content` mode.
    /// Ignored otherwise.
    #[serde(default)]
    pub context_before: u32,
    #[serde(default)]
    pub context_after: u32,
    /// Cap on results returned. Default 1000 — protects the UI from
    /// regex storms across large monorepos.
    #[serde(default)]
    pub head_limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepFileMatch {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepLine {
    pub line: u64,
    pub text: String,
    /// True when this row is a contextual line (-A / -B), false for an
    /// actual regex hit.
    pub is_match: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepContentMatch {
    pub path: String,
    pub matches: Vec<GrepLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepCountMatch {
    pub path: String,
    pub count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GrepResult {
    /// Returned when `mode = files`.
    Files { matches: Vec<GrepFileMatch> },
    /// Returned when `mode = content`.
    Content { matches: Vec<GrepContentMatch> },
    /// Returned when `mode = count`.
    Count { matches: Vec<GrepCountMatch> },
}

const GREP_DEFAULT_LIMIT: u32 = 1000;
const GREP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
pub fn grep_search(args: GrepArgs) -> Result<GrepResult, String> {
    let root = PathBuf::from(args.path.as_deref().unwrap_or("."));
    if !root.exists() {
        return Err(format!("grep_search: path does not exist: {}", root.display()));
    }

    let regex = RegexBuilder::new(&args.pattern)
        .case_insensitive(args.case_insensitive)
        .build()
        .map_err(|e| format!("grep_search: invalid regex: {e}"))?;

    // `ignore::WalkBuilder` honours .gitignore by default — code-search
    // semantics by default, just like ripgrep. Hidden files stay hidden.
    let mut walk = WalkBuilder::new(&root);
    walk.standard_filters(true);
    let walker = walk.build();

    let glob_match: Option<glob::Pattern> = match args.glob.as_deref() {
        Some(s) if !s.is_empty() => {
            Some(glob::Pattern::new(s).map_err(|e| format!("grep_search: invalid glob: {e}"))?)
        }
        _ => None,
    };

    let limit = args.head_limit.unwrap_or(GREP_DEFAULT_LIMIT);
    let mut files_out: Vec<GrepFileMatch> = Vec::new();
    let mut content_out: Vec<GrepContentMatch> = Vec::new();
    let mut count_out: Vec<GrepCountMatch> = Vec::new();
    let mut content_total: u32 = 0;

    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if let Some(g) = &glob_match {
            // Match against the path relative to the search root so a
            // pattern like `**/*.rs` lines up the way the user expects.
            let rel = path.strip_prefix(&root).unwrap_or(path);
            if !g.matches_path(rel) {
                continue;
            }
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > GREP_MAX_FILE_BYTES {
            continue; // skip giant files — likely binaries or generated bundles
        }
        let body = match fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue, // non-UTF8 or unreadable
        };

        match args.mode {
            GrepMode::Files => {
                if regex.is_match(&body) {
                    files_out.push(GrepFileMatch {
                        path: path.to_string_lossy().to_string(),
                    });
                    if files_out.len() as u32 >= limit {
                        break;
                    }
                }
            }
            GrepMode::Count => {
                let n = regex.find_iter(&body).count() as u64;
                if n > 0 {
                    count_out.push(GrepCountMatch {
                        path: path.to_string_lossy().to_string(),
                        count: n,
                    });
                    if count_out.len() as u32 >= limit {
                        break;
                    }
                }
            }
            GrepMode::Content => {
                let mut matches: Vec<GrepLine> = Vec::new();
                let lines: Vec<&str> = body.split('\n').collect();
                let before = args.context_before as usize;
                let after = args.context_after as usize;

                for (i, line) in lines.iter().enumerate() {
                    if !regex.is_match(line) {
                        continue;
                    }
                    let start = i.saturating_sub(before);
                    let end = (i + after + 1).min(lines.len());
                    for j in start..end {
                        // Dedupe — overlapping context windows shouldn't
                        // produce repeated rows when matches cluster.
                        if let Some(last) = matches.last() {
                            if last.line == (j as u64) + 1 {
                                continue;
                            }
                        }
                        matches.push(GrepLine {
                            line: (j as u64) + 1,
                            text: lines[j].to_string(),
                            is_match: j == i,
                        });
                    }
                    content_total += 1;
                    if content_total >= limit {
                        break;
                    }
                }
                if !matches.is_empty() {
                    content_out.push(GrepContentMatch {
                        path: path.to_string_lossy().to_string(),
                        matches,
                    });
                    if content_total >= limit {
                        break;
                    }
                }
            }
        }
    }

    Ok(match args.mode {
        GrepMode::Files => GrepResult::Files { matches: files_out },
        GrepMode::Content => GrepResult::Content {
            matches: content_out,
        },
        GrepMode::Count => GrepResult::Count {
            matches: count_out,
        },
    })
}

// -- Read PDF ------------------------------------------------------------

/// Hard cap on file size we'll attempt to extract. PDFs are arbitrary in
/// size and `pdf-extract` walks the document tree synchronously, so a
/// 500 MB scan would freeze the IPC thread. 50 MB covers everyday docs.
const READ_PDF_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Cap on returned text. Keeps a single tool result small enough to fit
/// in a chat window without truncating the model's reasoning budget.
/// 500 KB ≈ 100K tokens — plenty for any practical extraction.
const READ_PDF_MAX_TEXT_BYTES: usize = 500 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPdfResult {
    pub path: String,
    /// Extracted text, page-separated by form-feeds (\u{000C}). Truncated
    /// at READ_PDF_MAX_TEXT_BYTES with an explanatory marker when long.
    pub text: String,
    pub size: u64,
    /// True when the extracted body was clipped to the size cap.
    pub truncated: bool,
}

#[tauri::command]
pub fn read_pdf(
    app: AppHandle,
    path: String,
    progress_id: Option<String>,
) -> Result<ReadPdfResult, String> {
    let pid = progress_id.as_deref();
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("read_pdf: {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("read_pdf: not a regular file: {path}"));
    }
    let size = meta.len();
    if size > READ_PDF_MAX_BYTES {
        return Err(format!(
            "read_pdf: file too large ({size} bytes, max {READ_PDF_MAX_BYTES})"
        ));
    }

    let display = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    tool_progress::emit(
        &app,
        pid,
        format!(
            "Extracting text from {display} ({})…",
            tool_progress::format_bytes(size)
        ),
    );

    // pdf-extract's `extract_text` returns the whole document at once. It
    // can panic on adversarial input; wrap in catch_unwind so a malformed
    // PDF doesn't take the Tauri worker down with it.
    let extracted = std::panic::catch_unwind(|| pdf_extract::extract_text(&p))
        .map_err(|_| format!("read_pdf: extractor panicked on {path}"))?
        .map_err(|e| format!("read_pdf: {e}"))?;

    let mut text = extracted;
    let mut truncated = false;
    if text.len() > READ_PDF_MAX_TEXT_BYTES {
        // Cut at a UTF-8 char boundary so the truncated string stays valid.
        let mut cut = READ_PDF_MAX_TEXT_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n\n…[truncated by helix read_pdf]");
        truncated = true;
    }

    Ok(ReadPdfResult {
        path,
        text,
        size,
        truncated,
    })
}

// -- search_files (ripgrep) ----------------------------------------------
//
// Shells out to the actual `rg` binary so callers get ripgrep's full
// feature set — file-type filters (`-t`), multiline regex, hidden-file
// handling, the works. The pure-Rust `grep_search` above is kept around
// for environments where ripgrep isn't installed; `search_files` clearly
// reports that condition rather than silently falling back.

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesArgs {
    pub pattern: String,
    /// Search root. Defaults to the process working directory.
    #[serde(default)]
    pub path: Option<String>,
    /// `files` (default): list of paths. `content`: line-by-line matches
    /// with optional context. `count`: per-file match counts.
    #[serde(default)]
    pub mode: Option<String>,
    /// Optional secondary glob (`--glob`) — supports include / `!` exclude.
    #[serde(default)]
    pub glob: Option<String>,
    /// File-type filter (`--type`), e.g. `rust`, `py`, `ts`. See
    /// `rg --type-list` for the full set.
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub case_insensitive: Option<bool>,
    /// Treat the pattern as a literal string instead of a regex (`-F`).
    #[serde(default)]
    pub fixed_strings: Option<bool>,
    /// Allow regex to span multiple lines (`-U`).
    #[serde(default)]
    pub multiline: Option<bool>,
    /// Include hidden files (`--hidden`).
    #[serde(default)]
    pub include_hidden: Option<bool>,
    /// Per-file match cap (`--max-count`).
    #[serde(default)]
    pub max_count: Option<u32>,
    /// Total result cap. Default 1000.
    #[serde(default)]
    pub head_limit: Option<u32>,
    /// `content` mode only — lines of context emitted before each match.
    #[serde(default)]
    pub context_before: Option<u32>,
    /// `content` mode only — lines of context emitted after each match.
    #[serde(default)]
    pub context_after: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCountMatch {
    pub path: String,
    pub count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentLine {
    pub line: u64,
    pub text: String,
    /// True for an actual hit; false for a `-A` / `-B` context row.
    pub is_match: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentFile {
    pub path: String,
    pub matches: Vec<SearchContentLine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SearchFilesResult {
    Files { matches: Vec<String> },
    Count { matches: Vec<SearchCountMatch> },
    Content { matches: Vec<SearchContentFile> },
}

const SEARCH_DEFAULT_LIMIT: u32 = 1000;

#[tauri::command]
pub fn search_files(args: SearchFilesArgs) -> Result<SearchFilesResult, String> {
    let mode = args.mode.as_deref().unwrap_or("files").to_ascii_lowercase();
    if !["files", "content", "count"].contains(&mode.as_str()) {
        return Err(format!("search_files: unknown mode '{mode}'"));
    }

    let mut cmd = Command::new("rg");
    if args.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }
    if args.fixed_strings.unwrap_or(false) {
        cmd.arg("-F");
    }
    if args.multiline.unwrap_or(false) {
        cmd.arg("-U").arg("--multiline-dotall");
    }
    if args.include_hidden.unwrap_or(false) {
        cmd.arg("--hidden");
    }
    if let Some(g) = &args.glob {
        cmd.arg("--glob").arg(g);
    }
    if let Some(t) = &args.file_type {
        cmd.arg("--type").arg(t);
    }
    if let Some(mc) = args.max_count {
        cmd.arg("--max-count").arg(mc.to_string());
    }
    let limit = args.head_limit.unwrap_or(SEARCH_DEFAULT_LIMIT);

    match mode.as_str() {
        "files" => {
            cmd.arg("--files-with-matches");
        }
        "count" => {
            cmd.arg("--count").arg("--no-messages");
        }
        "content" => {
            cmd.arg("--json").arg("--no-messages");
            if let Some(b) = args.context_before {
                cmd.arg("-B").arg(b.to_string());
            }
            if let Some(a) = args.context_after {
                cmd.arg("-A").arg(a.to_string());
            }
        }
        _ => unreachable!(),
    }

    cmd.arg("--").arg(&args.pattern);
    if let Some(p) = &args.path {
        cmd.arg(p);
    }

    let output = cmd.output().map_err(|e| {
        format!(
            "search_files: failed to spawn `rg` ({e}). Install ripgrep \
             (`brew install ripgrep`, `apt install ripgrep`, etc.) and \
             ensure it's on PATH."
        )
    })?;

    // ripgrep exit codes:
    //   0 = matches found
    //   1 = no matches (still success — we return an empty result)
    //   2 = real error
    match output.status.code() {
        Some(0) | Some(1) => {}
        Some(other) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "search_files: rg exited with code {other}: {}",
                stderr.trim()
            ));
        }
        None => return Err("search_files: rg terminated by signal".to_string()),
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(match mode.as_str() {
        "files" => SearchFilesResult::Files {
            matches: parse_files_mode(&stdout, limit),
        },
        "count" => SearchFilesResult::Count {
            matches: parse_count_mode(&stdout, limit),
        },
        "content" => SearchFilesResult::Content {
            matches: parse_content_mode(&stdout, limit),
        },
        _ => unreachable!(),
    })
}

fn parse_files_mode(stdout: &str, limit: u32) -> Vec<String> {
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .take(limit as usize)
        .map(|s| s.to_string())
        .collect()
}

fn parse_count_mode(stdout: &str, limit: u32) -> Vec<SearchCountMatch> {
    let mut out: Vec<SearchCountMatch> = Vec::new();
    // ripgrep's `--count` output is `path:count`. Paths can contain `:`
    // on disk (rare on Unix; legal anywhere) so we split from the right
    // to peel off the trailing count.
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some((path, count_str)) = line.rsplit_once(':') {
            if let Ok(count) = count_str.parse::<u64>() {
                out.push(SearchCountMatch {
                    path: path.to_string(),
                    count,
                });
                if out.len() >= limit as usize {
                    break;
                }
            }
        }
    }
    out
}

/// Parse ripgrep's `--json` stream into `(path, [(line, text, is_match)])`
/// buckets. Each line of stdout is one event; we only act on `match` and
/// `context` events. Strings come back UTF-8-clean from ripgrep already.
fn parse_content_mode(stdout: &str, limit: u32) -> Vec<SearchContentFile> {
    use serde_json::Value;
    let mut total: u32 = 0;
    let mut current_path: Option<String> = None;
    let mut current_matches: Vec<SearchContentLine> = Vec::new();
    let mut out: Vec<SearchContentFile> = Vec::new();

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let data = match v.get("data") {
            Some(d) => d,
            None => continue,
        };
        match event_type {
            "begin" => {
                if let Some(prev) = current_path.take() {
                    if !current_matches.is_empty() {
                        out.push(SearchContentFile {
                            path: prev,
                            matches: std::mem::take(&mut current_matches),
                        });
                    }
                }
                current_path = json_path(data);
            }
            "match" | "context" => {
                let path_now = json_path(data);
                if path_now != current_path && path_now.is_some() {
                    if let Some(prev) = current_path.take() {
                        if !current_matches.is_empty() {
                            out.push(SearchContentFile {
                                path: prev,
                                matches: std::mem::take(&mut current_matches),
                            });
                        }
                    }
                    current_path = path_now;
                }
                let text = data
                    .get("lines")
                    .and_then(|l| l.get("text"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                let line_no = data
                    .get("line_number")
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0);
                current_matches.push(SearchContentLine {
                    line: line_no,
                    text,
                    is_match: event_type == "match",
                });
                if event_type == "match" {
                    total += 1;
                    if total >= limit {
                        break;
                    }
                }
            }
            "end" => {
                if let Some(prev) = current_path.take() {
                    if !current_matches.is_empty() {
                        out.push(SearchContentFile {
                            path: prev,
                            matches: std::mem::take(&mut current_matches),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(prev) = current_path.take() {
        if !current_matches.is_empty() {
            out.push(SearchContentFile {
                path: prev,
                matches: current_matches,
            });
        }
    }
    out
}

fn json_path(data: &serde_json::Value) -> Option<String> {
    data.get("path")
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEED: AtomicU64 = AtomicU64::new(0);

    fn tmp_dir(label: &str) -> PathBuf {
        let n = SEED.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "helix-tools-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_text_with_offset_limit() {
        let dir = tmp_dir("read");
        let p = dir.join("a.txt");
        fs::write(&p, "alpha\nbeta\ngamma\ndelta\n").unwrap();
        let r = read_file(p.to_string_lossy().to_string(), Some(1), Some(2)).unwrap();
        assert_eq!(r.total_lines, Some(4));
        assert!(r.content.contains("beta"));
        assert!(r.content.contains("gamma"));
        assert!(!r.content.contains("alpha"));
        assert!(!r.content.contains("delta"));
    }

    #[test]
    fn write_then_edit_unique() {
        let dir = tmp_dir("edit");
        let p = dir.join("x.txt");
        write_file(p.to_string_lossy().to_string(), "hello world".to_string()).unwrap();
        let res = edit_file(
            p.to_string_lossy().to_string(),
            "world".to_string(),
            "rust".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(res.replacements, 1);
        assert_eq!(fs::read_to_string(&p).unwrap(), "hello rust");
    }

    #[test]
    fn edit_rejects_ambiguous_match() {
        let dir = tmp_dir("edit-ambig");
        let p = dir.join("x.txt");
        fs::write(&p, "x\nx\n").unwrap();
        let err = edit_file(
            p.to_string_lossy().to_string(),
            "x".to_string(),
            "y".to_string(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("matched"));
    }

    #[test]
    fn edit_replace_all() {
        let dir = tmp_dir("edit-all");
        let p = dir.join("x.txt");
        fs::write(&p, "x\nx\nx\n").unwrap();
        let res = edit_file(
            p.to_string_lossy().to_string(),
            "x".to_string(),
            "y".to_string(),
            Some(true),
        )
        .unwrap();
        assert_eq!(res.replacements, 3);
        assert_eq!(fs::read_to_string(&p).unwrap(), "y\ny\ny\n");
    }

    #[test]
    fn glob_finds_files() {
        let dir = tmp_dir("glob");
        fs::write(dir.join("one.rs"), "").unwrap();
        fs::write(dir.join("two.rs"), "").unwrap();
        fs::write(dir.join("readme.md"), "").unwrap();
        let pat = dir.join("*.rs").to_string_lossy().to_string();
        let res = glob_files(pat, None).unwrap();
        assert_eq!(res.len(), 2);
    }

    #[test]
    fn grep_files_mode() {
        let dir = tmp_dir("grep");
        fs::write(dir.join("a.txt"), "needle here").unwrap();
        fs::write(dir.join("b.txt"), "nothing").unwrap();
        let res = grep_search(GrepArgs {
            pattern: "needle".to_string(),
            path: Some(dir.to_string_lossy().to_string()),
            ..GrepArgs::default()
        })
        .unwrap();
        match res {
            GrepResult::Files { matches } => {
                assert_eq!(matches.len(), 1);
                assert!(matches[0].path.ends_with("a.txt"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn grep_content_mode_with_context() {
        let dir = tmp_dir("grep-ctx");
        fs::write(dir.join("a.txt"), "one\ntwo\nthree\nNEEDLE\nfive\n").unwrap();
        let res = grep_search(GrepArgs {
            pattern: "NEEDLE".to_string(),
            path: Some(dir.to_string_lossy().to_string()),
            mode: GrepMode::Content,
            context_before: 1,
            context_after: 1,
            ..GrepArgs::default()
        })
        .unwrap();
        match res {
            GrepResult::Content { matches } => {
                assert_eq!(matches.len(), 1);
                let lines = &matches[0].matches;
                assert_eq!(lines.len(), 3);
                assert!(lines.iter().any(|l| l.is_match && l.text == "NEEDLE"));
            }
            _ => panic!("wrong variant"),
        }
    }
}
