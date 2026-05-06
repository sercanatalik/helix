//! Live progress events for long-running built-in tools.
//!
//! Tools like `web_fetch`, `read_excel`, and `read_pdf` can take seconds
//! before their `tauri::command` returns. The renderer subscribes to
//! `helix://tool-progress` and updates the live tool row's label as the
//! Rust side emits heartbeats, so the user sees what's actually happening
//! instead of a generic spinner.
//!
//! `id` correlates to the LLM-side tool call id, minted in the JS dispatcher
//! and passed through as the optional `progressId` field on each command's
//! args. Tools without a progress id (e.g. older callers, tests) are silent
//! by design — `emit` is a no-op when `id` is `None`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const TOOL_PROGRESS_EVENT: &str = "helix://tool-progress";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgressEvent {
    pub id: String,
    pub label: String,
}

/// Emit a progress event keyed by the caller's id. No-op when `id` is
/// `None`, so call sites can pass through `progress_id.as_deref()`
/// without pre-checking.
pub fn emit(app: &AppHandle, id: Option<&str>, label: impl Into<String>) {
    let Some(id) = id else { return };
    let _ = app.emit(
        TOOL_PROGRESS_EVENT,
        ToolProgressEvent {
            id: id.to_string(),
            label: label.into(),
        },
    );
}

/// Format a byte count with the smallest sensible unit so the heartbeat
/// reads "240 KB" rather than "245760 bytes". One decimal of precision
/// past KB; integer below.
pub fn format_bytes(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if n < KB {
        format!("{n} B")
    } else if n < MB {
        format!("{} KB", n / KB)
    } else if n < GB {
        format!("{:.1} MB", (n as f64) / (MB as f64))
    } else {
        format!("{:.2} GB", (n as f64) / (GB as f64))
    }
}
