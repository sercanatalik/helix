# Refactor Steps — Live Tool Progress, Iteration Budget & Round-Aware Transcript

## Summary

This refactor makes long-running agent loops feel responsive and bounded. Three concerns, all interlocking:

1. **Live tool progress.** A new Rust module (`tool_progress.rs`) emits `helix://tool-progress` events keyed by the LLM tool-call id. `web_fetch`, `read_pdf`, `read_excel`, and `analyse_data` emit heartbeats ("Connecting…", "Downloading 240 KB / 1.2 MB", "Building DataFrame (12000 × 8)…"). The renderer subscribes once at module scope, fans out by id, and patches the live tool-call row's new `progress` field. Cleared when the call settles.
2. **Bounded, prompt-aligned tool budget.** `MAX_TOOL_ITERATIONS` drops 25 → 12. Sub-agents drop 15 → 12. The `TOOL_USE_SYSTEM_PROMPT` is rewritten to teach the model the budget explicitly and to push parallel batches over serial calls. The post-loop "synthesise" round-trip is eliminated — instead the *last* iteration is run with `tool_choice:"none"` so synthesis happens in-loop and saves one HTTP call. Old tool results (older than 3 rounds, larger than 2KB) are demoted to one-line summaries in the API stack so context doesn't grow unboundedly; the UI keeps full results.
3. **Round-aware transcript.** Tool call records carry a `round` number. The transcript draws a slim `Round N · M calls · Tms` divider between groups when an assistant message went through ≥2 rounds. A new `awaitingResponse` flag on `TranscriptMessage` re-arms the "Thinking…" status during the silent gap between iterations. Pre-tool-call text ("Let me check the file…") is now committed across iterations into a `committedPreamble` so the user's view stays continuous instead of getting wiped each round. Dispatched sub-agents also surface their live content/reasoning as the parent's tool-result preview while running.

| Area | Files | Net effect |
|---|---|---|
| Rust progress channel | `src-tauri/src/tool_progress.rs` (NEW), `src-tauri/src/lib.rs` | Module registered; emits `helix://tool-progress` events keyed by call id |
| Rust tool emitters | `src-tauri/src/web_fetch.rs`, `src-tauri/src/tools.rs` (`read_pdf`), `src-tauri/src/data_tools.rs` (`read_excel`, `analyse_data`) | Each accepts optional `progress_id` and emits heartbeats; `web_fetch` reads the body in chunks with a 150ms throttle |
| TS types | `src/app/types.ts` | `ToolCallRecord.round`, `ToolCallRecord.progress`, `TranscriptMessage.awaitingResponse` |
| TS plumbing | `src/lib/api/builtin-tools.ts`, `src/lib/builtin-tools/dispatcher.ts` | `progressId` threaded from `useChat` → dispatcher → Tauri command |
| Sub-agent | `src/lib/agent/sub-agent.ts` | `onTextProgress` callback added; iteration cap 15→12; new system-prompt line about parallel batches |
| Agent loop | `src/hooks/use-chat.ts` | Listener registry, in-loop synthesis, tool-result aging, preamble commit, round numbering, `awaitingResponse` flag, dispatch_agent live preview |
| UI | `src/features/chat/transcript.tsx`, `src/styles/components/chat.css` | Round divider component, `tool-cap-progress` label, status-line keyed off `awaitingResponse` |

---

## Implementation instructions for another LLM agent

> Goal: Apply the changes below to a clean checkout of the `helix` repo at HEAD `9909e13` (`feat: optimize MCP and Helix Core popovers …`). Stack: Vite + React 18/19 + TypeScript + Tauri (Rust). Repo: `/Users/sercan/codebase/ai-works/helix`.
>
> The end state is what `git diff` produces against this baseline plus one new file, `src-tauri/src/tool_progress.rs`.
>
> Do NOT add features, refactors, or tests beyond what's specified. Do NOT change any other files.

### Preflight

1. `git status` should be clean. If not, stop and ask the user.
2. Read these files into context first — match existing style and surrounding code exactly:
   - `src-tauri/src/lib.rs`
   - `src-tauri/src/tools.rs` (only the `read_pdf` command at the bottom matters)
   - `src-tauri/src/data_tools.rs` (the `read_excel` and `analyse_data` commands)
   - `src-tauri/src/web_fetch.rs`
   - `src/app/types.ts` (`ToolCallRecord`, `TranscriptMessage`)
   - `src/lib/api/builtin-tools.ts` (the `builtinToolsApi` object)
   - `src/lib/builtin-tools/dispatcher.ts` (the `runBuiltinTool` function)
   - `src/lib/agent/sub-agent.ts`
   - `src/hooks/use-chat.ts` (the entire file — the changes here are deep)
   - `src/features/chat/transcript.tsx` (`MessageViewImpl`, `ToolCallGroupList`, `PlainToolRow`)
   - `src/styles/components/chat.css` (just to know where to append)

---

### Step 1 — Create `src-tauri/src/tool_progress.rs` (NEW FILE)

This is the module the rest of the Rust changes will import. It exposes:
- The event name constant `TOOL_PROGRESS_EVENT = "helix://tool-progress"`
- A `ToolProgressEvent` payload struct (`id`, `label`)
- `emit(app, id_opt, label)` — no-op when `id_opt` is `None`
- `format_bytes(n)` — pretty-prints a byte count

Write the file with this exact contents:

```rust
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
```

---

### Step 2 — Register the module in `src-tauri/src/lib.rs`

**Before** (top-of-file `mod` declarations):

```rust
mod mcp;
mod mcp_defaults;
mod notes;
mod skills;
mod tools;
mod types;
mod web_fetch;
```

**After** — insert one new `mod tool_progress;` line in alphabetical position:

```rust
mod mcp;
mod mcp_defaults;
mod notes;
mod skills;
mod tool_progress;
mod tools;
mod types;
mod web_fetch;
```

Nothing else in `lib.rs` changes.

---

### Step 3 — `src-tauri/src/tools.rs` — emit progress from `read_pdf`

#### 3a — Add import + AppHandle use

**Before** (after the doc comment block, top of imports):

```rust
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ignore::WalkBuilder;
use regex::RegexBuilder;
```

**After** — prepend `crate::tool_progress`:

```rust
use crate::tool_progress;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ignore::WalkBuilder;
use regex::RegexBuilder;
```

**Before** (at the bottom of the imports):

```rust
use std::process::Command;
use std::time::SystemTime;
```

**After** — append a `tauri::AppHandle` import:

```rust
use std::process::Command;
use std::time::SystemTime;
use tauri::AppHandle;
```

#### 3b — Update the `read_pdf` signature and body

Locate the `read_pdf` command (searches for `pub fn read_pdf`). Its current shape:

```rust
#[tauri::command]
pub fn read_pdf(path: String) -> Result<ReadPdfResult, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("read_pdf: {path}: {e}"))?;
    if !meta.is_file() {
        ...
    }
    let size = meta.len();
    if size > MAX_PDF_BYTES {
        return Err(format!(
            ...
        ));
    }

    // pdf-extract's `extract_text` ...
```

Replace with this version. Two changes: (a) signature now takes `AppHandle` and `Option<String>` for `progress_id`; (b) after the size check, emit a single heartbeat saying "Extracting text from {filename} ({size})…":

```rust
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
    if size > MAX_PDF_BYTES {
        return Err(format!(
            "read_pdf: file too large ({size} bytes > {MAX_PDF_BYTES} byte cap)"
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
```

Keep the rest of the body verbatim. The `if !meta.is_file()` and the `if size > MAX_PDF_BYTES` blocks must NOT have their existing error messages changed — only the surrounding shape changes. (If the existing `if !meta.is_file()` body in your checkout differs from `return Err(format!("read_pdf: not a regular file: {path}"));`, keep whatever the existing body is — only the signature and the new `tool_progress::emit` are added.)

---

### Step 4 — `src-tauri/src/data_tools.rs` — emit progress from `read_excel` and `analyse_data`

#### 4a — Add import + AppHandle use

**Before** (top of imports):

```rust
use calamine::{open_workbook_auto, Data, Reader};
use polars::prelude::*;
```

**After** — prepend `crate::tool_progress`:

```rust
use crate::tool_progress;
use calamine::{open_workbook_auto, Data, Reader};
use polars::prelude::*;
```

**Before** (further down):

```rust
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;
```

**After** — extend the tauri import to include `AppHandle`:

```rust
use std::sync::Mutex;
use tauri::{AppHandle, State};
use uuid::Uuid;
```

#### 4b — Update `read_excel`

Locate the existing command (search `pub fn read_excel`). Current shape:

```rust
#[tauri::command]
pub fn read_excel(
    path: String,
    sheet: Option<String>,
    has_header: Option<bool>,
    store: State<'_, DataFrameStore>,
) -> Result<ReadExcelResult, String> {
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("read_excel: file not found: {path}"));
    }
    let mut book =
        open_workbook_auto(&pb).map_err(|e| format!("read_excel: open {path}: {e}"))?;
    let sheet_names: Vec<String> = book.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err(format!("read_excel: workbook has no sheets: {path}"));
    }
    let target = sheet.unwrap_or_else(|| sheet_names[0].clone());
    let range = book
        .worksheet_range(&target)
        .map_err(|e| format!("read_excel: sheet '{target}': {e}"))?;

    let df = range_to_dataframe(&range, has_header.unwrap_or(true))
        .map_err(|e| format!("read_excel: build DataFrame: {e}"))?;
    let handle = new_handle();
```

Replace with the same logic plus three heartbeats — open, read, build:

```rust
#[tauri::command]
pub fn read_excel(
    app: AppHandle,
    path: String,
    sheet: Option<String>,
    has_header: Option<bool>,
    progress_id: Option<String>,
    store: State<'_, DataFrameStore>,
) -> Result<ReadExcelResult, String> {
    let pid = progress_id.as_deref();
    let pb = PathBuf::from(&path);
    if !pb.exists() {
        return Err(format!("read_excel: file not found: {path}"));
    }
    let display = pb
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&path)
        .to_string();
    tool_progress::emit(&app, pid, format!("Opening workbook {display}…"));
    let mut book =
        open_workbook_auto(&pb).map_err(|e| format!("read_excel: open {path}: {e}"))?;
    let sheet_names: Vec<String> = book.sheet_names().to_vec();
    if sheet_names.is_empty() {
        return Err(format!("read_excel: workbook has no sheets: {path}"));
    }
    let target = sheet.unwrap_or_else(|| sheet_names[0].clone());
    tool_progress::emit(&app, pid, format!("Reading sheet '{target}'…"));
    let range = book
        .worksheet_range(&target)
        .map_err(|e| format!("read_excel: sheet '{target}': {e}"))?;

    let (rows, cols) = (range.height(), range.width());
    tool_progress::emit(
        &app,
        pid,
        format!("Building DataFrame ({rows} × {cols})…"),
    );
    let df = range_to_dataframe(&range, has_header.unwrap_or(true))
        .map_err(|e| format!("read_excel: build DataFrame: {e}"))?;
    let handle = new_handle();
```

The rest of the function body stays unchanged.

Note ordering of arguments: `app`, then `path`, then `sheet`, then `has_header`, **then `progress_id`**, finally `store`. Tauri commands match by argument name (camelCased), so the JS side must send `progressId` as a sibling of `path`/`sheet`/`hasHeader` — Step 7 handles that.

#### 4c — Update `analyse_data`

Locate the existing command (search `pub fn analyse_data`). Current shape:

```rust
#[tauri::command]
pub fn analyse_data(
    args: AnalyseArgs,
    store: State<'_, DataFrameStore>,
) -> Result<AnalyseResult, String> {
    let source = args.handle.clone();
    store.touch(&source);
    let snapshot = store
        .with_frame(&source, |df| df.clone())
        .ok_or_else(|| format!("analyse_data: unknown handle: {source}"))?;

    let (op_label, derived) = run_op(&snapshot, &args.operation)?;
```

Replace with:

```rust
#[tauri::command]
pub fn analyse_data(
    app: AppHandle,
    args: AnalyseArgs,
    progress_id: Option<String>,
    store: State<'_, DataFrameStore>,
) -> Result<AnalyseResult, String> {
    let pid = progress_id.as_deref();
    let source = args.handle.clone();
    store.touch(&source);
    let snapshot = store
        .with_frame(&source, |df| df.clone())
        .ok_or_else(|| format!("analyse_data: unknown handle: {source}"))?;

    let (rows, cols) = snapshot.shape();
    tool_progress::emit(
        &app,
        pid,
        format!(
            "Running {} on {rows} × {cols} frame…",
            op_kind_label(&args.operation)
        ),
    );

    let (op_label, derived) = run_op(&snapshot, &args.operation)?;
```

The rest of the function body (computing shape, columns, building `AnalyseResult`) stays unchanged.

#### 4d — Add the `op_kind_label` helper

Immediately after `analyse_data`'s closing brace `}` (and before `fn run_op(...)`), insert this helper. It's only used to build the heartbeat label without running the op.

```rust
/// Verb-only label for the progress heartbeat — `run_op` already returns
/// the same string but only after the operation finishes, which is too
/// late for "Running X on …" feedback. Cheap to derive here without
/// running the op.
fn op_kind_label(op: &AnalyseOp) -> &'static str {
    match op {
        AnalyseOp::Describe => "describe",
        AnalyseOp::Head { .. } => "head",
        AnalyseOp::Tail { .. } => "tail",
        AnalyseOp::Schema => "schema",
        AnalyseOp::Select { .. } => "select",
        AnalyseOp::Filter { .. } => "filter",
        AnalyseOp::Sort { .. } => "sort",
        AnalyseOp::GroupBy { .. } => "group_by",
        AnalyseOp::Pivot { .. } => "pivot",
        AnalyseOp::Unique { .. } => "unique",
        AnalyseOp::ValueCounts { .. } => "value_counts",
    }
}
```

The `AnalyseOp` variants must match exactly what's in the existing enum. If a variant in your checkout is named differently or has a different shape, mirror it — but as of the baseline commit, those eleven variants are correct.

---

### Step 5 — `src-tauri/src/web_fetch.rs` — chunked download with byte-count heartbeats

This is the largest Rust change: rewrite the body-read path to stream chunks with a 150ms throttle, and emit start/connect/decode heartbeats around it.

#### 5a — Imports

**Before**:

```rust
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
```

**After** — add the progress import, extend `time` to include `Instant`, add `tauri::AppHandle`:

```rust
use crate::tool_progress;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::AppHandle;
```

#### 5b — Add the throttle constant

**Before** (the existing constants block):

```rust
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

#[tauri::command]
pub async fn web_fetch(args: WebFetchArgs) -> Result<WebFetchResponse, String> {
```

**After** — add `PROGRESS_THROTTLE` and update the `web_fetch` signature:

```rust
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// How often we emit a "downloading…" heartbeat while reading the body
/// stream. Tight enough to feel live, loose enough that a fast LAN page
/// doesn't drown the channel in events.
const PROGRESS_THROTTLE: Duration = Duration::from_millis(150);

#[tauri::command]
pub async fn web_fetch(
    app: AppHandle,
    args: WebFetchArgs,
    progress_id: Option<String>,
) -> Result<WebFetchResponse, String> {
    let pid = progress_id.as_deref();
```

#### 5c — Add a "Connecting to {host}…" heartbeat before the request fires

Find the block that resolves `max_bytes` and immediately calls `client.get(url).send().await`:

```rust
        .min(HARD_MAX_BYTES)
        .max(MIN_MAX_BYTES);

    let client = build_client(args.proxy.as_ref()).map_err(|e| e.to_string())?;

    let response = client
        .get(url)
```

Replace with — adds the host-label derivation, the "Connecting…" heartbeat, and changes `let response` to `let mut response` so we can call `response.chunk()` later:

```rust
        .min(HARD_MAX_BYTES)
        .max(MIN_MAX_BYTES);

    let host_label = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(url);
    tool_progress::emit(&app, pid, format!("Connecting to {host_label}…"));

    let client = build_client(args.proxy.as_ref()).map_err(|e| e.to_string())?;

    let mut response = client
        .get(url)
```

#### 5d — Capture `total_size`, emit "downloading" heartbeat, and replace the `bytes()` call with chunked read

Find the existing block (after `content_type` is computed):

```rust
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // Capture the body even on non-2xx so the model can read consent walls,
    // anti-bot pages (Yahoo Finance returns HTTP 500 to plain HTTP clients,
    // for example), or "page moved" notices and pivot. The status is
    // surfaced prominently in the response so the agent loop can react. We
    // still bail on bodies we can't usefully decode — same rule as the
    // success path.
    let raw = response
        .bytes()
        .await
        .map_err(|e| format!("web_fetch: read body failed: {e}"))?;

    let body_text = match classify(&content_type) {
        BodyKind::Html => extract_html_text(&raw),
        BodyKind::Text | BodyKind::Json => String::from_utf8_lossy(&raw).into_owned(),
        BodyKind::Unsupported => {
```

Replace with — adds total-size capture, "HTTP X · downloading…" heartbeat, the chunk loop with throttled byte-count heartbeats, and a per-classification "Decoding…" / "Extracting…" heartbeat right before decoding. Note `classify(&content_type)` is now hoisted to a `kind` local because we need to inspect it for the heartbeat AND match on it for decoding:

```rust
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let total_size = response.content_length();

    let total_label = total_size
        .map(|n| format!(" / {}", tool_progress::format_bytes(n)))
        .unwrap_or_default();
    tool_progress::emit(
        &app,
        pid,
        format!("HTTP {status} · downloading{total_label}…"),
    );

    // Capture the body even on non-2xx so the model can read consent walls,
    // anti-bot pages (Yahoo Finance returns HTTP 500 to plain HTTP clients,
    // for example), or "page moved" notices and pivot. The status is
    // surfaced prominently in the response so the agent loop can react. We
    // still bail on bodies we can't usefully decode — same rule as the
    // success path. Read in chunks so we can heartbeat the running byte
    // count back to the renderer instead of silently buffering for seconds.
    let mut buf: Vec<u8> = Vec::with_capacity(total_size.unwrap_or(0).min(1 << 20) as usize);
    let mut last_emit = Instant::now();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if last_emit.elapsed() >= PROGRESS_THROTTLE {
                    let label = match total_size {
                        Some(t) => format!(
                            "Downloading… {} / {}",
                            tool_progress::format_bytes(buf.len() as u64),
                            tool_progress::format_bytes(t),
                        ),
                        None => format!(
                            "Downloading… {}",
                            tool_progress::format_bytes(buf.len() as u64)
                        ),
                    };
                    tool_progress::emit(&app, pid, label);
                    last_emit = Instant::now();
                }
            }
            Ok(None) => break,
            Err(e) => {
                return Err(format!("web_fetch: read body failed: {e}"));
            }
        }
    }
    let raw = buf;

    let kind = classify(&content_type);
    tool_progress::emit(
        &app,
        pid,
        match kind {
            BodyKind::Html => "Extracting readable text…",
            BodyKind::Json => "Decoding JSON body…",
            BodyKind::Text => "Decoding text body…",
            BodyKind::Unsupported => "Unsupported content type",
        },
    );
    let body_text = match kind {
        BodyKind::Html => extract_html_text(&raw),
        BodyKind::Text | BodyKind::Json => String::from_utf8_lossy(&raw).into_owned(),
        BodyKind::Unsupported => {
```

The rest of the function body (the `BodyKind::Unsupported` arm onwards) stays unchanged. Note that the original code called `classify(&content_type)` once inline in the match expression — the new code computes it into `kind` first. That's the only structural difference past the chunk loop.

---

### Step 6 — `src/app/types.ts` — extend `ToolCallRecord` and `TranscriptMessage`

#### 6a — Extend `ToolCallRecord`

Find the existing `nestedCalls` field at the bottom of the interface:

```ts
  /**
   * Undefined for ordinary tool calls; never set on the nested records
   * themselves (depth-1 only). */
  readonly nestedCalls?: readonly ToolCallRecord[];
}
```

Insert two new fields immediately before the closing brace:

```ts
  /**
   * Undefined for ordinary tool calls; never set on the nested records
   * themselves (depth-1 only). */
  readonly nestedCalls?: readonly ToolCallRecord[];
  /** 1-indexed agent loop round this call belongs to. Used by the
   * transcript to slot a "Round N" divider between iterations so the
   * user can see where each tool batch starts. Optional because older
   * persisted records were written before this field existed. */
  readonly round?: number;
  /** Live heartbeat label emitted by the underlying tool while it's
   * running (e.g. "Connecting to example.com…", "Downloading 240 KB").
   * Surfaced inline in the running row so long-running tools don't sit
   * silent. Cleared once the call settles — `result` takes over. */
  readonly progress?: string;
}
```

#### 6b — Extend `TranscriptMessage`

Find the existing `reasoningStatus` field:

```ts
   * Streamed in alongside `content`; rendered as a collapsible block. */
  readonly reasoning?: string;
  readonly reasoningStatus?: "streaming" | "complete";
}
```

Insert one new field immediately before the closing brace:

```ts
   * Streamed in alongside `content`; rendered as a collapsible block. */
  readonly reasoning?: string;
  readonly reasoningStatus?: "streaming" | "complete";
  /** True while the model is between an HTTP round-trip and its first
   * delta — either at request start, or in the gap between a finished
   * tool round and the model's next reply. Drives the "Thinking…"
   * indicator so the user gets feedback during quiet periods even when
   * a preamble is already visible. Cleared on the first content /
   * reasoning / tool-call delta of each iteration. */
  readonly awaitingResponse?: boolean;
}
```

---

### Step 7 — `src/lib/api/builtin-tools.ts` — thread `progressId` through to Tauri

Four method signatures change. In each, an optional `progressId` is appended to the JS API and forwarded as `progressId` in the `invoke()` payload.

#### 7a — `readPdf`

**Before**:

```ts
  /** Extract plain text from a PDF using the pure-Rust pdf-extract
   * pipeline. Best-effort on scanned / image-only PDFs (returns the
   * embedded text layer only — there's no OCR). Hard-capped at 50 MB
   * input and 500 KB output. */
  readPdf: (path: string): Promise<ReadPdfResult> =>
    invoke<ReadPdfResult>("read_pdf", { path }),
```

**After**:

```ts
  /** Extract plain text from a PDF using the pure-Rust pdf-extract
   * pipeline. Best-effort on scanned / image-only PDFs (returns the
   * embedded text layer only — there's no OCR). Hard-capped at 50 MB
   * input and 500 KB output. `progressId` is the LLM tool-call id; when
   * supplied the Rust side emits `helix://tool-progress` events so the
   * renderer can show a live label while the extractor runs. */
  readPdf: (path: string, progressId?: string): Promise<ReadPdfResult> =>
    invoke<ReadPdfResult>("read_pdf", { path, progressId }),
```

#### 7b — `readExcel`

**Before**:

```ts
  readExcel: (
    path: string,
    options?: ReadExcelOptions,
  ): Promise<ReadExcelResult> =>
    invoke<ReadExcelResult>("read_excel", {
      path,
      sheet: options?.sheet,
      hasHeader: options?.hasHeader,
    }),
```

**After**:

```ts
  readExcel: (
    path: string,
    options?: ReadExcelOptions,
    progressId?: string,
  ): Promise<ReadExcelResult> =>
    invoke<ReadExcelResult>("read_excel", {
      path,
      sheet: options?.sheet,
      hasHeader: options?.hasHeader,
      progressId,
    }),
```

#### 7c — `analyseData`

**Before**:

```ts
  /** Run a single statistical operation against a DataFrame handle. The
   * operation produces a derived DataFrame (filter/sort/group_by/pivot/
   * select/describe/...) that's stored under a fresh handle so chains
   * stay cheap to express. */
  analyseData: (handle: string, op: AnalyseOp): Promise<AnalyseResult> =>
    invoke<AnalyseResult>("analyse_data", {
      args: { handle, operation: op },
    }),
```

**After**:

```ts
  /** Run a single statistical operation against a DataFrame handle. The
   * operation produces a derived DataFrame (filter/sort/group_by/pivot/
   * select/describe/...) that's stored under a fresh handle so chains
   * stay cheap to express. */
  analyseData: (
    handle: string,
    op: AnalyseOp,
    progressId?: string,
  ): Promise<AnalyseResult> =>
    invoke<AnalyseResult>("analyse_data", {
      args: { handle, operation: op },
      progressId,
    }),
```

#### 7d — `webFetch`

**Before**:

```ts
   * verbatim. Routed through the corporate proxy when one is configured —
   * same per-call snapshot pattern as {@link webSearch}. */
  webFetch: (args: WebFetchArgs): Promise<WebFetchResponse> =>
    invoke<WebFetchResponse>("web_fetch", { args }),
};
```

**After**:

```ts
   * verbatim. Routed through the corporate proxy when one is configured —
   * same per-call snapshot pattern as {@link webSearch}. `progressId`
   * lets the renderer subscribe to live byte-count heartbeats during the
   * download; pass the LLM tool-call id when invoked from the agent loop. */
  webFetch: (
    args: WebFetchArgs,
    progressId?: string,
  ): Promise<WebFetchResponse> =>
    invoke<WebFetchResponse>("web_fetch", { args, progressId }),
};
```

---

### Step 8 — `src/lib/builtin-tools/dispatcher.ts` — accept and forward `progressId`

Two changes: extend the function signature, and forward the id to the four tools that emit progress.

#### 8a — Update doc comment + signature of `runBuiltinTool`

**Before**:

```ts
/** Run a built-in tool by name. Returns the same `{ result, isError }`
 * shape `useChat` expects from MCP tool calls so the agent loop stays
 * uniform regardless of which transport produced the result. */
export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
```

**After**:

```ts
/** Run a built-in tool by name. Returns the same `{ result, isError }`
 * shape `useChat` expects from MCP tool calls so the agent loop stays
 * uniform regardless of which transport produced the result.
 *
 * `progressId` is the LLM tool-call id; when supplied, tools that
 * support live progress (`web_fetch`, `read_pdf`, `read_excel`,
 * `analyse_data`) forward it to Rust so the renderer can subscribe to
 * heartbeat events for that specific call. Other tools ignore it. */
export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  progressId?: string,
): Promise<{ result: string; isError: boolean }> {
```

#### 8b — Forward in `read_pdf` case

**Before**:

```ts
        const r = await window.helixApi.readPdf(resolved);
```

**After**:

```ts
        const r = await window.helixApi.readPdf(resolved, progressId);
```

#### 8c — Forward in `read_excel` case

**Before**:

```ts
        const r = await window.helixApi.readExcel(resolved, {
          sheet,
          hasHeader: typeof has_header === "boolean" ? has_header : undefined,
        });
```

**After**:

```ts
        const r = await window.helixApi.readExcel(
          resolved,
          {
            sheet,
            hasHeader: typeof has_header === "boolean" ? has_header : undefined,
          },
          progressId,
        );
```

#### 8d — Forward in `analyse_data` case

**Before**:

```ts
        const r = await window.helixApi.analyseData(handle, op);
```

**After**:

```ts
        const r = await window.helixApi.analyseData(handle, op, progressId);
```

#### 8e — Forward in `web_fetch` case

**Before**:

```ts
        const r = await window.helixApi.webFetch({
          url: url.trim(),
          maxBytes: typeof max_bytes === "number" ? max_bytes : undefined,
          proxy: proxy && proxy.enabled && proxy.host ? proxy : undefined,
        });
```

**After**:

```ts
        const r = await window.helixApi.webFetch(
          {
            url: url.trim(),
            maxBytes: typeof max_bytes === "number" ? max_bytes : undefined,
            proxy: proxy && proxy.enabled && proxy.host ? proxy : undefined,
          },
          progressId,
        );
```

The `dispatch_agent` case is **not** modified — sub-agent live preview is wired separately in `useChat`, not via this Rust progress channel.

---

### Step 9 — `src/lib/agent/sub-agent.ts` — `onTextProgress`, smaller budget, prompt nudge

#### 9a — Add `onTextProgress` to `RunSubAgentOptions`

**Before** (the `onProgress` doc + field at the end of the interface):

```ts
   * The parent uses this to keep its UI's nested view (when present)
   * up-to-date. Not load-bearing — the function still works without it. */
  readonly onProgress?: (records: readonly ToolCallRecord[]) => void;
}
```

**After** — append the new field:

```ts
   * The parent uses this to keep its UI's nested view (when present)
   * up-to-date. Not load-bearing — the function still works without it. */
  readonly onProgress?: (records: readonly ToolCallRecord[]) => void;
  /** Optional callback fired (rate-limited) whenever the sub-agent
   * streams content or reasoning text. The parent uses this to surface
   * a live preview of what the sub-agent is doing so its dispatch row
   * doesn't sit silent for the entire run. Snapshot is rAF-coalesced
   * upstream — emit eagerly here, the parent throttles. */
  readonly onTextProgress?: (snapshot: {
    readonly content: string;
    readonly reasoning: string;
  }) => void;
}
```

#### 9b — Lower the iteration cap

**Before**:

```ts
const DEFAULT_MAX_ITERATIONS = 15;
```

**After**:

```ts
const DEFAULT_MAX_ITERATIONS = 12;
```

#### 9c — Add a tool-budget bullet to the sub-agent system prompt

**Before**:

```ts
const SUB_AGENT_SYSTEM_PROMPT =
  "Use tools to gather concrete evidence, then return a direct answer to the task. " +
  "Your final reply will be handed back verbatim as the parent's tool result, so:\n" +
  "- Be concise and factual; skip preamble like \"Here is the answer\".\n" +
  "- If you ran tools, summarise what you found — don't dump raw output.\n" +
  "- If the task is impossible with the tools available, say so plainly.";
```

**After** — insert the new bullet between "Be concise…" and "If you ran tools…":

```ts
const SUB_AGENT_SYSTEM_PROMPT =
  "Use tools to gather concrete evidence, then return a direct answer to the task. " +
  "Your final reply will be handed back verbatim as the parent's tool result, so:\n" +
  "- Be concise and factual; skip preamble like \"Here is the answer\".\n" +
  "- Keep your total tool calls under 12. Batch independent calls in parallel in one turn rather than serializing them, and stop as soon as you have enough evidence to answer.\n" +
  "- If you ran tools, summarise what you found — don't dump raw output.\n" +
  "- If the task is impossible with the tools available, say so plainly.";
```

#### 9d — Wire live text-progress into the streaming loop

Find the section (in `runSubAgent`, just before the iteration `for` loop) that builds the `emit` helper:

```ts
    if (!opts.onProgress) return;
    opts.onProgress(callRecords.map((r) => ({ ...r })));
  };

  let finalContent = "";
  let budgetExhausted = false;
```

Replace with — adds `liveContent`/`liveReasoning` accumulators and an `emitTextProgress` helper:

```ts
    if (!opts.onProgress) return;
    opts.onProgress(callRecords.map((r) => ({ ...r })));
  };
  // Cross-iteration accumulators for the live text preview the parent
  // shows under its dispatch row. Reasoning resets per iteration only
  // visually (it's a chain-of-thought, not a final answer); content
  // here is the running sub-agent output, not the eventual finalContent.
  let liveContent = "";
  let liveReasoning = "";
  const emitTextProgress = () => {
    if (!opts.onTextProgress) return;
    opts.onTextProgress({ content: liveContent, reasoning: liveReasoning });
  };

  let finalContent = "";
  let budgetExhausted = false;
```

Now find the streaming-delta block inside `runSubAgent`:

```ts
      if (delta?.content) acc += delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
```

Replace with — fan content/reasoning deltas into the live accumulators and emit:

```ts
      if (delta?.content) {
        acc += delta.content;
        liveContent += delta.content;
        emitTextProgress();
      }
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoningDelta) {
        liveReasoning += reasoningDelta;
        emitTextProgress();
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
```

(There is no existing reasoning-delta handling in `runSubAgent` — the new block introduces it. If your checkout already has a `reasoning_content` block in `runSubAgent`, stop and re-read the file; the baseline does not.)

---

### Step 10 — `src/hooks/use-chat.ts` — the largest TS change

Many independent edits in this file. Apply them in order.

#### 10a — Import `listen` from Tauri's event API

**Before** (top of file):

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { BUILTIN_SERVER_ID, runBuiltinTool } from "../lib/builtin-tools";
```

**After** — insert the `listen` import in the second slot:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { BUILTIN_SERVER_ID, runBuiltinTool } from "../lib/builtin-tools";
```

#### 10b — Replace the `MAX_TOOL_ITERATIONS` block with the new constants + listener registry

**Before** (the existing `MAX_TOOL_ITERATIONS` const and its doc comment, immediately after the `import type { ToolCallRecord, TranscriptMessage } from "../app/types";` line):

```ts
/** Maximum tool-call iterations before we force a final answer. Set high
 * enough for genuine agentic work (explore → search → read several files →
 * re-search → analyse → fetch → summarise) without letting a runaway model
 * loop indefinitely. When we hit this cap we don't just bail — we issue
 * one final call with `tool_choice: "none"` so the user gets a synthesis
 * from whatever evidence was gathered instead of a blank message. */
const MAX_TOOL_ITERATIONS = 25;
```

**After** — replace with the listener registry, the new `MAX_TOOL_ITERATIONS = 12`, the `TOOL_AGING_*` constants, and updated comment:

```ts
/** Live progress payload emitted by the Rust side (`tool_progress.rs`).
 * Routed by call id to the in-flight tool record so the running row can
 * show "Connecting…" / "Downloading 240 KB" instead of a generic spinner. */
const TOOL_PROGRESS_EVENT = "helix://tool-progress";
interface ToolProgressPayload {
  readonly id: string;
  readonly label: string;
}

/** Module-level registry of "tool-call id → onProgress callback". Lazily
 * attaches a single `listen()` so we don't open a fresh subscription per
 * `useChat` mount or per send. The listener fan-outs by id and silently
 * drops events for ids no one's waiting on. Outside a Tauri runtime
 * (vite dev), `listen()` rejects — we swallow that and progress just
 * never fires, matching the rest of the app's degraded-mode behaviour. */
const toolProgressCallbacks = new Map<string, (label: string) => void>();
let toolProgressUnlisten: Promise<UnlistenFn> | undefined;
function ensureToolProgressListener(): void {
  if (toolProgressUnlisten) return;
  toolProgressUnlisten = listen<ToolProgressPayload>(
    TOOL_PROGRESS_EVENT,
    (event) => {
      const cb = toolProgressCallbacks.get(event.payload.id);
      if (cb) cb(event.payload.label);
    },
  ).catch((err) => {
    // Fall back to a no-op unlisten so we don't keep retrying. In a
    // non-Tauri env this is the expected path.
    void err;
    return () => {};
  });
}
function registerToolProgress(
  callId: string,
  cb: (label: string) => void,
): () => void {
  ensureToolProgressListener();
  toolProgressCallbacks.set(callId, cb);
  return () => {
    toolProgressCallbacks.delete(callId);
  };
}

/** Maximum tool-call iterations before we force a final answer. Aligned
 * with the under-12 guidance in TOOL_USE_SYSTEM_PROMPT so the prompt and
 * the runtime cap agree. With parallel_tool_calls each iteration can fan
 * out — that's the intended way to do breadth without burning the budget.
 * When we hit this cap we don't just bail — we issue one final call with
 * `tool_choice: "none"` so the user gets a synthesis from whatever
 * evidence was gathered instead of a blank message. */
const MAX_TOOL_ITERATIONS = 12;
```

#### 10c — Add `TOOL_AGING_*` constants right after `MAX_TOOL_RESULT_BYTES`

Find the existing `MAX_TOOL_RESULT_BYTES` block. After it, before the `TOOL_USE_SYSTEM_PROMPT` block, insert the two new constants:

**Before**:

```ts
 * UI transcript still shows the full untruncated result. */
const MAX_TOOL_RESULT_BYTES = 60_000;

/** Hidden system message prepended whenever the request carries tools.
```

**After**:

```ts
 * UI transcript still shows the full untruncated result. */
const MAX_TOOL_RESULT_BYTES = 60_000;

/** Tool results from rounds older than this many iterations get demoted
 * to a one-line summary in the API stack so a long agent loop's context
 * doesn't grow unboundedly. The model can re-issue the call if it needs
 * the full data — usually it's already extracted what it needed. The
 * UI transcript keeps every result at full size so the user can audit. */
const TOOL_AGING_AFTER_ROUNDS = 3;
/** Don't bother summarising results below this size — the savings don't
 * justify hiding evidence the model might still glance at. Tuned roughly
 * to "one screenful of grep output". */
const TOOL_AGING_MIN_BYTES = 2000;

/** Hidden system message prepended whenever the request carries tools.
```

#### 10d — Rewrite `TOOL_USE_SYSTEM_PROMPT`

**Before**:

```ts
const TOOL_USE_SYSTEM_PROMPT =
  "You have access to tools. Use them to gather concrete evidence before you answer — do not guess at file contents, search results, or web data.\n\n" +
  "Guidelines:\n" +
  "- Issue multiple tool calls in parallel when the work is independent (reading several files, running multiple searches). One turn can contain many tool_calls.\n" +
  "- If a tool returns truncated output, call it again with a wider window (offset, max_bytes, head_limit, larger limit) to read more.\n" +
  "- If a tool fails, briefly note the failure and try a different approach — for example use glob_files or grep_search to locate a missing path, or web_search before web_fetch.\n" +
  "- Do not repeat an identical tool call you just made; if you need different data, change the arguments.\n" +
  "- Stop calling tools and write the final answer once you have enough evidence.";
```

**After**:

```ts
const TOOL_USE_SYSTEM_PROMPT =
  "You have access to tools. Use them to gather concrete evidence before you answer — do not guess at file contents, search results, or web data.\n\n" +
  "Guidelines:\n" +
  "- Keep the total number of tool calls in your response under 12. Plan upfront which calls you actually need, and prefer one well-scoped call over several narrow ones.\n" +
  "- Issue independent tool calls in parallel in a single turn (e.g. reading several files, running multiple searches at once) instead of serializing them — parallel batches count as one round and are the cheapest way to stay under the 12-call budget.\n" +
  "- Before each new tool call, ask whether you already have enough evidence to answer; if yes, stop and write the response.\n" +
  "- If a tool returns truncated output, call it again with a wider window (offset, max_bytes, head_limit, larger limit) to read more — but widen aggressively so one retry is enough.\n" +
  "- If a tool fails, briefly note the failure and try a different approach — for example use glob_files or grep_search to locate a missing path, or web_search before web_fetch.\n" +
  "- Do not repeat an identical tool call you just made; if you need different data, change the arguments.\n" +
  "- For broad or multi-faceted exploration that would otherwise need many calls, use dispatch_agent to delegate it — the sub-agent's calls don't count toward your budget.";
```

#### 10e — `runToolCall` accepts an optional `progressId`

Find the `runToolCall` function (search `async function runToolCall`):

**Before**:

```ts
async function runToolCall(
  binding: McpToolBinding | undefined,
  rawName: string,
  rawArgs: string,
): Promise<{ result: string; isError: boolean }> {
```

**After** — append `progressId?: string`:

```ts
async function runToolCall(
  binding: McpToolBinding | undefined,
  rawName: string,
  rawArgs: string,
  progressId?: string,
): Promise<{ result: string; isError: boolean }> {
```

And in the body where it forwards to `runBuiltinTool`:

**Before**:

```ts
    if (binding.serverId === BUILTIN_SERVER_ID) {
      return await runBuiltinTool(binding.toolName, args);
    }
```

**After**:

```ts
    if (binding.serverId === BUILTIN_SERVER_ID) {
      return await runBuiltinTool(binding.toolName, args, progressId);
    }
```

#### 10f — Mark the assistant stub `awaitingResponse: true` at message construction

Find the block where the assistant placeholder message is created (search `status: "streaming",`). Look for:

**Before**:

```ts
        content: "",
        createdAt: nowIso(),
        status: "streaming",
      };

      const transcriptHistory = [...messagesRef.current, userMsg];
```

**After** — add the `awaitingResponse` flag with comment:

```ts
        content: "",
        createdAt: nowIso(),
        status: "streaming",
        // Live until the first delta of any kind arrives — drives the
        // "Thinking…" indicator across HTTP wait time and the silent
        // gap between iterations.
        awaitingResponse: true,
      };

      const transcriptHistory = [...messagesRef.current, userMsg];
```

#### 10g — Add `committedPreamble` accumulator alongside `reasoningAcc`

Find the `let reasoningAcc = "";` declaration. Right after it, add the new `committedPreamble` declaration:

**Before**:

```ts
        // emit thinking before each tool call as well as before the final
        // response, so we keep one buffer per assistant message.
        let reasoningAcc = "";
        // Vega-Lite blocks salvaged from tool results — appended to the
```

**After**:

```ts
        // emit thinking before each tool call as well as before the final
        // response, so we keep one buffer per assistant message.
        let reasoningAcc = "";
        // Pre-tool-call text the model emitted across earlier iterations.
        // Each iteration that ends in tool_calls commits its acc here so
        // "Let me check the file…" preambles survive into the final
        // message instead of being wiped when the next iteration starts
        // with an empty buffer. The streaming patch always renders
        // `committedPreamble + acc` so the user sees a continuous reply
        // building up across tool rounds.
        let committedPreamble = "";
        // Vega-Lite blocks salvaged from tool results — appended to the
```

#### 10h — Extend `runDispatchAgent` to take `onTextProgress`

Find the existing signature of the inner `runDispatchAgent` arrow (search `const runDispatchAgent = async`):

**Before**:

```ts
        const runDispatchAgent = async (
          rawArgs: string,
          onProgress?: (records: readonly ToolCallRecord[]) => void,
        ): Promise<{ result: string; isError: boolean }> => {
```

**After**:

```ts
        const runDispatchAgent = async (
          rawArgs: string,
          onProgress?: (records: readonly ToolCallRecord[]) => void,
          onTextProgress?: (snapshot: {
            readonly content: string;
            readonly reasoning: string;
          }) => void,
        ): Promise<{ result: string; isError: boolean }> => {
```

Inside its body, find where it calls `runSubAgent` and add `onTextProgress` to the options object:

**Before**:

```ts
              systemPrompt,
              signal: ac.signal,
              onProgress,
            });
```

**After**:

```ts
              systemPrompt,
              signal: ac.signal,
              onProgress,
              onTextProgress,
            });
```

#### 10i — Replace `normalExit` tracking with the tool-aging meta + summary builder

Find the block right before the `for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++)` loop. Current shape:

```ts
        // the immediately-preceding round, nudging the model to vary
        // its arguments instead of looping on the same lookup.
        let lastCallSignatures = new Set<string>();
        // True iff the model emitted a final text answer (finish_reason
        // ≠ "tool_calls"). When false after the loop terminates we made
        // the cap without a synthesis — handled by the fallback below.
        let normalExit = false;

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          if (ac.signal.aborted) break;
          const stream = client.chatStream(
```

Replace with — drops `normalExit`, introduces the `ToolMessageMeta` array and `buildToolSummary` helper, then the new loop preamble (aging + re-arm `awaitingResponse` + force-synthesis branch):

```ts
        // the immediately-preceding round, nudging the model to vary
        // its arguments instead of looping on the same lookup.
        let lastCallSignatures = new Set<string>();

        // Tracks every role:"tool" message we've appended, with the
        // iteration that produced it and a one-line summary. On long
        // loops we walk this list at iteration start and replace
        // older messages' content with the summary so the request body
        // doesn't grow unboundedly. Aging is reversible only by the
        // model re-issuing the same call.
        interface ToolMessageMeta {
          readonly apiIndex: number;
          readonly iteration: number;
          readonly summary: string;
          readonly fullBytes: number;
          aged: boolean;
        }
        const toolMessageMetas: ToolMessageMeta[] = [];

        // Build a one-line summary of a tool result for the aging path.
        // Keeps the head and tail short enough that the model can still
        // recognise what the call returned without re-running it.
        const buildToolSummary = (
          toolName: string,
          rawArgs: string,
          fullContent: string,
          isError: boolean,
        ): string => {
          const argDigest =
            rawArgs && rawArgs.length > 80
              ? `${rawArgs.slice(0, 77)}…`
              : rawArgs || "{}";
          const firstLine =
            fullContent.split("\n", 1)[0]?.slice(0, 120) ?? "";
          const status = isError ? " [error]" : "";
          return (
            `[aged] ${toolName}(${argDigest}) → ${fullContent.length} bytes${status}` +
            (firstLine ? `; first line: ${firstLine}` : "") +
            "\n[note] Full result elided to keep context lean. Re-issue the same call if you need the data again."
          );
        };

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          if (ac.signal.aborted) break;

          // Age old tool results before sending the next request. We
          // mutate apiMessages[idx].content in place; meta.aged guards
          // against repeating the work each iteration.
          if (iter > 0 && toolMessageMetas.length > 0) {
            for (const meta of toolMessageMetas) {
              if (meta.aged) continue;
              if (iter - meta.iteration <= TOOL_AGING_AFTER_ROUNDS) continue;
              if (meta.fullBytes < TOOL_AGING_MIN_BYTES) {
                meta.aged = true;
                continue;
              }
              const target = apiMessages[meta.apiIndex];
              if (target && target.role === "tool") {
                apiMessages[meta.apiIndex] = {
                  role: "tool",
                  tool_call_id: target.tool_call_id,
                  content: meta.summary,
                };
              }
              meta.aged = true;
            }
          }

          // Re-arm the "Thinking…" indicator for iterations after the
          // first. The initial stub already has awaitingResponse=true; on
          // the second+ iteration the previous round's `markFirstDelta`
          // cleared it, so without this patch the indicator would stay
          // hidden across the silent inter-iteration gap.
          if (iter > 0) {
            patch((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, awaitingResponse: true } : m,
              ),
            );
          }

          // Last allowed iteration when we've already gathered evidence:
          // pin tool_choice to "none" so the model is forced to synthesise
          // a final answer in this round. Saves the separate post-loop
          // round-trip we used to make for the same purpose — and that
          // one was the slowest, since the context was at its largest by
          // the time it fired.
          const forceSynthesis =
            iter === MAX_TOOL_ITERATIONS - 1 &&
            tools.length > 0 &&
            callRecords.length > 0;
          if (forceSynthesis) {
            apiMessages.push({
              role: "system",
              content:
                "Tool-call budget reached. Synthesise a final answer from the evidence above. Do not request more tools.",
            });
          }

          const stream = client.chatStream(
```

#### 10j — Update the `chatStream` arguments to honour `forceSynthesis`

Find the existing `chatStream` argument block:

**Before**:

```ts
          const stream = client.chatStream(
            {
              model: chosenModel,
              messages: apiMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? "auto" : undefined,
              // Encourage providers (notably OpenAI) to emit multiple
              // tool_calls in a single turn so we can dispatch them in
              // parallel below. User-supplied extra_params spread last
              // can override (e.g. a buggy proxy that mishandles it).
              ...(tools.length > 0 ? { parallel_tool_calls: true } : {}),
              [tokenLimitField]: tokenLimit,
              ...buildExtraBody(provider),
            },
            { signal: ac.signal },
          );
```

**After** — `tool_choice` becomes ternary based on `forceSynthesis`, `parallel_tool_calls` is skipped on the synthesis iteration, and `buildExtraBody(provider)` is replaced by the already-hoisted `extraBody` (no new local needed; the `const extraBody = buildExtraBody(provider);` already exists earlier in the function — reuse it):

```ts
          const stream = client.chatStream(
            {
              model: chosenModel,
              messages: apiMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice:
                tools.length > 0
                  ? forceSynthesis
                    ? "none"
                    : "auto"
                  : undefined,
              // Encourage providers (notably OpenAI) to emit multiple
              // tool_calls in a single turn so we can dispatch them in
              // parallel below. User-supplied extra_params spread last
              // can override (e.g. a buggy proxy that mishandles it).
              // Skip on the synthesis iteration — no tools will fire.
              ...(tools.length > 0 && !forceSynthesis
                ? { parallel_tool_calls: true }
                : {}),
              [tokenLimitField]: tokenLimit,
              ...extraBody,
            },
            { signal: ac.signal },
          );
```

#### 10k — Replace `liveStreamed` with `firstDeltaSeen` / `markFirstDelta`

Find the per-iteration locals just before the chunk-consume loop:

**Before**:

```ts
          let acc = "";
          const toolCalls: AccumulatedToolCall[] = [];
          let finishReason: string | null = null;
          let liveStreamed = false;

          for await (const chunk of stream) {
```

**After** — replace `liveStreamed` with the new helper:

```ts
          let acc = "";
          const toolCalls: AccumulatedToolCall[] = [];
          let finishReason: string | null = null;
          // Cleared on the first delta of any kind — drives the
          // "Thinking…" indicator while the HTTP request is in flight.
          let firstDeltaSeen = false;
          const markFirstDelta = () => {
            if (firstDeltaSeen) return;
            firstDeltaSeen = true;
            patch((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, awaitingResponse: false } : m,
              ),
            );
          };

          for await (const chunk of stream) {
```

#### 10l — Call `markFirstDelta()` from each delta arm; replace the conditional content streaming

Find the `delta?.tool_calls` arm:

**Before**:

```ts
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
```

**After**:

```ts
            if (delta?.tool_calls) {
              markFirstDelta();
              for (const tc of delta.tool_calls) {
```

Find the reasoning arm:

**Before**:

```ts
            const reasoningDelta =
              delta?.reasoning_content ?? delta?.reasoning;
            if (reasoningDelta) {
              reasoningAcc += reasoningDelta;
```

**After**:

```ts
            const reasoningDelta =
              delta?.reasoning_content ?? delta?.reasoning;
            if (reasoningDelta) {
              markFirstDelta();
              reasoningAcc += reasoningDelta;
```

Find the `delta?.content` arm — this is the biggest change in the chunk loop. The conditional logic (`if (toolCalls.length === 0) … else if (liveStreamed) …`) is replaced by an unconditional render of `committedPreamble + acc`:

**Before**:

```ts
            if (delta?.content) {
              acc += delta.content;
              // Stream content live only when we're confident the iteration
              // won't end with tool_calls — namely when the model started by
              // emitting plain text and hasn't requested any tool yet. If a
              // tool_call delta arrives later, we revert to hidden mode.
              if (toolCalls.length === 0) {
                liveStreamed = true;
                const snapshot = acc;
                patch((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: snapshot } : m,
                  ),
                );
              } else if (liveStreamed) {
                // A tool_call started after we'd already streamed text —
                // hide the prefix; it'll be replaced by the post-tool
                // response when the loop continues.
                liveStreamed = false;
                patch((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: "" } : m,
                  ),
                );
              }
            }
```

**After**:

```ts
            if (delta?.content) {
              markFirstDelta();
              acc += delta.content;
              // Stream every chunk live, including text that turns out to
              // precede a tool_call ("Let me check the file…"). When the
              // iteration ends in tool_calls we commit `acc` into
              // `committedPreamble` below, so the next iteration's empty
              // buffer doesn't wipe the user's view of the preamble.
              const snapshot = committedPreamble + acc;
              patch((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: snapshot } : m,
                ),
              );
            }
```

#### 10m — Gate the tool-call dispatch on `!forceSynthesis`

Find the post-stream branch:

**Before**:

```ts
          // Post-stream: branch on whether the model wants more tool calls.
          if (finishReason === "tool_calls" && toolCalls.length > 0) {
            // Round-trip the assistant tool_calls + tool results without
            // touching the transcript. The user only sees the final
            // post-tool response.
```

**After** — adds the `!forceSynthesis &&` guard and an extra comment. The guard means even if a misbehaving model defies `tool_choice:"none"` and emits tool_calls, we drop them and end the loop:

```ts
          // Post-stream: branch on whether the model wants more tool calls.
          // On the synthesis iteration we never dispatch — even if the
          // model defied tool_choice:"none" and emitted tool_calls, the
          // budget is already spent.
          if (
            !forceSynthesis &&
            finishReason === "tool_calls" &&
            toolCalls.length > 0
          ) {
            // Round-trip the assistant tool_calls + tool results without
            // touching the transcript. The user only sees the final
            // post-tool response.
```

#### 10n — Add `round: iter + 1` to each new `callRecords` entry

Find the block where the loop pushes new `callRecords` entries (search `result: "",`, `status: "running"`):

**Before**:

```ts
                result: "",
                status: "running",
                isError: false,
              });
            }
            patchCallRecords();
```

**After**:

```ts
                result: "",
                status: "running",
                isError: false,
                round: iter + 1,
              });
            }
            patchCallRecords();
```

#### 10o — Wire live progress + dispatch_agent text preview into the dispatch fan-out

Locate the `Promise.all` over the tool calls (search `const startedAt = performance.now();`). The current shape:

```ts
                const startedAt = performance.now();
                const { result: rawResult, isError } = isDispatchAgent
                  ? await runDispatchAgent(tc.arguments, (nested) => {
                      // Patch the parent dispatch_agent record with the
                      // sub-agent's live tool-call snapshot so the
                      // transcript can render the nested run as it
                      // happens. We mutate the record at its known
                      // index — Promise.all's parallel map siblings
                      // touch their own indices, so there's no race.
                      const idx = recordIndex.get(callId);
                      if (idx !== undefined && callRecords[idx]) {
                        callRecords[idx] = {
                          ...callRecords[idx]!,
                          nestedCalls: nested,
                        };
                        patchCallRecords();
                      }
                    })
                  : await runToolCall(binding, tc.name, tc.arguments);
```

Replace with — adds the `unregisterProgress` registration (which patches `callRecords[idx].progress` on each heartbeat), passes `onTextProgress` to dispatch_agent for live text preview, passes `callId` as `progressId` to `runToolCall`, and unregisters after the call settles:

```ts
                const startedAt = performance.now();
                // Subscribe to live progress heartbeats for this specific
                // call. Tools that don't emit (everything except web_fetch
                // / read_pdf / read_excel / analyse_data) just leave the
                // callback dormant — no heartbeat ever fires, no patches.
                const unregisterProgress = isDispatchAgent
                  ? undefined
                  : registerToolProgress(callId, (label) => {
                      const idx = recordIndex.get(callId);
                      if (idx === undefined || !callRecords[idx]) return;
                      callRecords[idx] = {
                        ...callRecords[idx]!,
                        progress: label,
                      };
                      patchCallRecords();
                    });
                const { result: rawResult, isError } = isDispatchAgent
                  ? await runDispatchAgent(
                      tc.arguments,
                      (nested) => {
                        // Patch the parent dispatch_agent record with the
                        // sub-agent's live tool-call snapshot so the
                        // transcript can render the nested run as it
                        // happens. We mutate the record at its known
                        // index — Promise.all's parallel map siblings
                        // touch their own indices, so there's no race.
                        const idx = recordIndex.get(callId);
                        if (idx !== undefined && callRecords[idx]) {
                          callRecords[idx] = {
                            ...callRecords[idx]!,
                            nestedCalls: nested,
                          };
                          patchCallRecords();
                        }
                      },
                      ({ content, reasoning }) => {
                        // Surface the sub-agent's running text into the
                        // dispatch row's `result` so the user sees what
                        // the sub-agent is doing instead of a silent
                        // spinner. Replaced verbatim once the sub-agent
                        // settles below.
                        const idx = recordIndex.get(callId);
                        if (idx === undefined || !callRecords[idx]) return;
                        const preview = content.trim()
                          ? content
                          : reasoning.trim()
                            ? `[thinking]\n${reasoning}`
                            : "";
                        if (!preview) return;
                        callRecords[idx] = {
                          ...callRecords[idx]!,
                          result: preview,
                        };
                        patchCallRecords();
                      },
                    )
                  : await runToolCall(binding, tc.name, tc.arguments, callId);
                unregisterProgress?.();
```

#### 10p — Clear `progress` and capture `toolName`/`toolArgs` when the call settles

Find where the settled call updates `callRecords[idx]`:

**Before**:

```ts
                    status: isError ? "error" : "complete",
                    isError,
                    durationMs,
                  };
                  patchCallRecords();
                }
                return { callId, rawResult, modelResult, isError };
              }),
            );
```

**After** — adds `progress: undefined,` and extends the returned object so the post-loop appender can build summaries:

```ts
                    status: isError ? "error" : "complete",
                    isError,
                    durationMs,
                    // Settled rows show the result; the heartbeat label
                    // is no longer meaningful and would otherwise stick.
                    progress: undefined,
                  };
                  patchCallRecords();
                }
                return {
                  callId,
                  rawResult,
                  modelResult,
                  isError,
                  toolName: tc.name,
                  toolArgs: tc.arguments || "{}",
                };
              }),
            );
```

#### 10q — Replace the post-`Promise.all` apiMessages append + commit preamble

Find the loop that appends `role: "tool"` messages, and the `lastCallSignatures = thisRoundSignatures;` line. Current:

```ts
            for (const { callId, modelResult } of settled) {
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: modelResult,
              });
            }
            lastCallSignatures = thisRoundSignatures;
            // Loop back for the next iteration.
            continue;
          }

          // Terminal: this iteration's text is the final response.
          finalContent = acc;
          normalExit = true;
          break;
        }
```

Replace with — destructures the new fields, records `toolMessageMetas` per tool message, commits any pre-tool-call text into `committedPreamble`, and changes the terminal branch to render `committedPreamble + acc`:

```ts
            for (const {
              callId,
              modelResult,
              toolName,
              toolArgs,
              isError,
            } of settled) {
              const apiIndex = apiMessages.length;
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: modelResult,
              });
              // Record the meta so a later iteration can swap this
              // entry's content for the one-line summary if it ages.
              toolMessageMetas.push({
                apiIndex,
                iteration: iter,
                fullBytes: modelResult.length,
                summary: buildToolSummary(
                  toolName,
                  toolArgs,
                  modelResult,
                  isError,
                ),
                aged: false,
              });
            }
            // Commit any text the model emitted before its tool calls so
            // the live transcript keeps showing it on subsequent
            // iterations and it survives into the final message.
            if (acc.trim().length > 0) {
              committedPreamble += acc.endsWith("\n") ? acc : `${acc}\n\n`;
            }
            lastCallSignatures = thisRoundSignatures;
            // Loop back for the next iteration.
            continue;
          }

          // Terminal: this iteration's text is the final response. Prepend
          // any preamble accumulated from earlier tool-call iterations so
          // the user reads the model's full reasoning, not just the
          // closing summary.
          finalContent = committedPreamble + acc;
          break;
        }
```

(Note: the `normalExit = true;` line is gone. We're switching from a post-loop synthesis call to in-loop synthesis — the next step removes the post-loop block entirely.)

#### 10r — Replace the post-loop synthesis block with the safety-net branch

Find the block right after the `for` loop closing brace (search `// Budget exhausted without a textual answer`). Current shape (sizable; spans ~70 lines):

```ts
        // Budget exhausted without a textual answer: do one more call
        // with `tool_choice: "none"` so the model is forced to summarise
        // from the evidence we already gathered. Without this, hitting
        // the iteration cap left the assistant message blank.
        if (
          !normalExit &&
          !ac.signal.aborted &&
          callRecords.length > 0 &&
          tools.length > 0
        ) {
          apiMessages.push({
            role: "system",
            content:
              "Tool-call budget reached. Synthesise a final answer from the evidence above. Do not request more tools.",
          });
          const stream = client.chatStream(
            {
              model: chosenModel,
              messages: apiMessages,
              tools,
              tool_choice: "none",
              [tokenLimitField]: tokenLimit,
              ...buildExtraBody(provider),
            },
            { signal: ac.signal },
          );
          let acc = "";
          for await (const chunk of stream) {
            // ... reasoning + content patching ...
          }
          finalContent =
            acc ||
            "_(stopped — tool-call budget exhausted with no synthesis from the model)_";
        }
```

Replace the entire block with this much smaller safety net (the in-loop `forceSynthesis` already does the synthesis, so this only handles a misbehaving model that defied `tool_choice:"none"`):

```ts
        // Safety net: the in-loop `forceSynthesis` should always populate
        // finalContent on the last iteration, but if a misbehaving model
        // defied tool_choice:"none" and emitted nothing, fall back to the
        // preamble we already showed the user — or, failing that, a
        // plain "stopped" placeholder so the bubble isn't blank.
        if (!ac.signal.aborted && !finalContent.trim()) {
          if (committedPreamble.trim()) {
            finalContent = committedPreamble.trimEnd();
          } else if (callRecords.length > 0) {
            finalContent =
              "_(stopped — tool-call budget exhausted with no synthesis from the model)_";
          }
        }
```

#### 10s — Clear `awaitingResponse` on the three completion patches

Find the success-completion patch (search `content: finalContent,` and `status: "complete",`):

**Before**:

```ts
                  ...m,
                  content: finalContent,
                  status: "complete",
                  toolCalls:
                    callRecords.length > 0
```

**After** — insert `awaitingResponse: false`:

```ts
                  ...m,
                  content: finalContent,
                  status: "complete",
                  awaitingResponse: false,
                  toolCalls:
                    callRecords.length > 0
```

Find the abort-completion patch (search `content: m.content || "_(stopped)_"`):

**Before**:

```ts
                ? {
                    ...m,
                    status: "complete",
                    content: m.content || "_(stopped)_",
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    // Mark any still-running tool calls as errored so the
```

**After**:

```ts
                ? {
                    ...m,
                    status: "complete",
                    awaitingResponse: false,
                    content: m.content || "_(stopped)_",
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    // Mark any still-running tool calls as errored so the
```

Find the error-completion patch (search ``content: m.content || `**Error:** ${detail}` ``):

**Before**:

```ts
                ? {
                    ...m,
                    status: "error",
                    content: m.content || `**Error:** ${detail}`,
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    toolCalls: m.toolCalls?.map((c) =>
```

**After**:

```ts
                ? {
                    ...m,
                    status: "error",
                    awaitingResponse: false,
                    content: m.content || `**Error:** ${detail}`,
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    toolCalls: m.toolCalls?.map((c) =>
```

That completes the `use-chat.ts` edits.

---

### Step 11 — `src/features/chat/transcript.tsx` — round dividers, progress label, awaitingResponse

`Fragment` is already imported in line 1 of the baseline (`import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";`) — no import edit needed.

#### 11a — Update `MessageViewImpl`'s `showStatusLine` and surrounding comment

**Before** (in `MessageViewImpl`):

```tsx
  // Show the "Churning…▎" line whenever the assistant is working but the
  // user can't otherwise tell — i.e. no live text yet AND reasoning isn't
  // animating its own cursor. Tool calls in flight count as "working with
  // nothing to type yet", so we keep the cursor visible across them; once
  // post-tool content starts streaming, the typed text itself is the live
  // edge and the status line steps out of the way.
  const showStatusLine =
    isAssistant &&
    streaming &&
    !reasoningStreaming &&
    !message.content;
  const verb = useRotatingVerb(isAssistant && streaming);
```

**After** — comment rewritten, condition extended to OR with `awaitingResponse`:

```tsx
  // Show the "Churning…▎" line whenever the assistant is working but the
  // user can't otherwise tell — either we're waiting for the model's
  // first delta of a fresh iteration (`awaitingResponse`), or there's
  // simply nothing to render yet AND reasoning isn't animating its own
  // cursor. The `awaitingResponse` arm matters once preamble text from
  // earlier iterations is on screen: without it, the status line would
  // vanish during the silent gap between a finished tool round and the
  // model's next reply.
  const showStatusLine =
    isAssistant &&
    streaming &&
    !reasoningStreaming &&
    (message.awaitingResponse || !message.content);
  const verb = useRotatingVerb(isAssistant && streaming);
```

#### 11b — Compute `distinctRounds` / `showRoundDividers` in `ToolCallGroupList`

Find the `ToolCallGroupList` function. Just before the `return (` that opens with `<div className="tool-block" role="list">`, insert the round-detection logic:

**Before**:

```tsx
  return (
    <div className="tool-block" role="list">
      {groups.map((group, idx) => {
```

**After**:

```tsx
  // Tag each group with the round number it belongs to (taken from its
  // first call). Distinct rounds get a divider between them so the user
  // can see iteration boundaries when the model fanned out across
  // multiple turns. Single-round runs (the common case) skip dividers.
  const distinctRounds = new Set<number>();
  for (const group of groups) {
    const round = group.calls[0]?.round;
    if (typeof round === "number") distinctRounds.add(round);
  }
  const showRoundDividers = distinctRounds.size >= 2;

  return (
    <div className="tool-block" role="list">
      {groups.map((group, idx) => {
```

#### 11c — Replace the per-group `return` with the divider-aware variant

Find the existing per-group body (right inside the `groups.map((group, idx) => {`):

**Before**:

```tsx
      {groups.map((group, idx) => {
        // A solo successful call stays inline — wrapping a single ✓ row in
        // a collapsible header would be more chrome than information. Any
        // error or any second call promotes the run to the group treatment.
        const promote = group.calls.length >= 2 || group.retries > 0;
        if (!promote) {
          const only = group.calls[0]!;
          return <ToolRow key={only.id || `${idx}:${only.toolName}`} call={only} />;
        }
        return (
          <ToolCallGroup
            key={`${group.serverName}:${idx}`}
            group={group}
            streaming={streaming}
          />
        );
      })}
    </div>
  );
}
```

**After** — restructure to compute `groupNode`, then optionally wrap with a `RoundDivider` in a `Fragment`:

```tsx
      {groups.map((group, idx) => {
        const round = group.calls[0]?.round;
        const prevRound = idx > 0 ? groups[idx - 1]?.calls[0]?.round : undefined;
        const showDivider =
          showRoundDividers &&
          typeof round === "number" &&
          round !== prevRound;

        // A solo successful call stays inline — wrapping a single ✓ row in
        // a collapsible header would be more chrome than information. Any
        // error or any second call promotes the run to the group treatment.
        const promote = group.calls.length >= 2 || group.retries > 0;
        const groupNode = !promote ? (
          (() => {
            const only = group.calls[0]!;
            return <ToolRow key={only.id || `${idx}:${only.toolName}`} call={only} />;
          })()
        ) : (
          <ToolCallGroup
            key={`${group.serverName}:${idx}`}
            group={group}
            streaming={streaming}
          />
        );
        if (!showDivider) return groupNode;
        // Sum durations for every call in this round (across all groups
        // in this round) so the divider doubles as a per-round timing.
        let roundCalls = 0;
        let roundMs = 0;
        for (const g of groups) {
          if (g.calls[0]?.round !== round) continue;
          roundCalls += g.calls.length;
          for (const c of g.calls) {
            if (typeof c.durationMs === "number") roundMs += c.durationMs;
          }
        }
        return (
          <Fragment key={`round-${round}-${idx}`}>
            <RoundDivider
              round={round!}
              callCount={roundCalls}
              totalMs={roundMs}
            />
            {groupNode}
          </Fragment>
        );
      })}
    </div>
  );
}
```

#### 11d — Add the `RoundDivider` component

Immediately after the `ToolCallGroupList` closing brace, before the `interface CallGroup {` declaration, insert:

```tsx
function RoundDivider({
  round,
  callCount,
  totalMs,
}: {
  readonly round: number;
  readonly callCount: number;
  readonly totalMs: number;
}) {
  return (
    <div className="tool-round-divider" role="presentation">
      <span className="tool-round-divider-line" aria-hidden />
      <span className="tool-round-divider-label">
        Round {round} · {callCount} {callCount === 1 ? "call" : "calls"}
        {totalMs > 0 ? ` · ${formatDuration(totalMs)}` : ""}
      </span>
      <span className="tool-round-divider-line" aria-hidden />
    </div>
  );
}
```

(`formatDuration` is already in scope in this file — it's the same helper the row capsules use for `durationMs`.)

#### 11e — Render the live progress label in `PlainToolRow`

Find the running-state capsule render (search `capsuleStatus === "run"` near `tool-cap-args`):

**Before**:

```tsx
        ) : (
          <span className="tool-cap-args" />
        )}
        {call.durationMs !== undefined ? (
          <span className="tool-cap-ms">{formatDuration(call.durationMs)}</span>
        ) : null}
```

**After** — insert the `tool-cap-progress` span between the args fallback and the `durationMs`:

```tsx
        ) : (
          <span className="tool-cap-args" />
        )}
        {capsuleStatus === "run" && call.progress ? (
          <span className="tool-cap-progress" title={call.progress}>
            {call.progress}
          </span>
        ) : null}
        {call.durationMs !== undefined ? (
          <span className="tool-cap-ms">{formatDuration(call.durationMs)}</span>
        ) : null}
```

---

### Step 12 — `src/styles/components/chat.css` — round divider + progress styles

Find the existing `flex-shrink: 0;` line that ends the `tool-cap-*` block (the one immediately before the `/* ---------- Collapsed tool-call group ---------- */` section). Append both new blocks immediately after the closing `}` of that `tool-cap-*` rule, before the collapsed-group section:

**Before**:

```css
  flex-shrink: 0;
}

/* ---------- Collapsed tool-call group ---------- */
```

**After** — insert two new blocks:

```css
  flex-shrink: 0;
}

/* ---------- Round divider ----------
 * Slim "Round N · M calls · Tms" rule between tool groups produced by
 * different agent-loop iterations. Only rendered when the assistant
 * message went through ≥2 rounds — single-round runs skip it. */
.tool-round-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 2px;
}
.tool-round-divider-line {
  flex: 1 1 0;
  height: 1px;
  background: var(--border-subtle);
}
.tool-round-divider-label {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--fg-dim);
  flex-shrink: 0;
}

/* ---------- Tool progress label ----------
 * Live heartbeat from the underlying tool while it's running ("Connecting
 * to example.com…", "Downloading 240 KB"). Sits inline next to the tool
 * name so the user sees what the call is actually doing instead of a
 * generic spinner. Cleared once the call settles. */
.tool-cap-progress {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-dim);
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ---------- Collapsed tool-call group ---------- */
```


### What NOT to change

- Do NOT modify other Tauri commands (`read_file`, `grep_search`, `glob_files`, `web_search`, etc.) to emit progress. Only the four explicitly listed support live progress in this revision.
- Do NOT add UI animations to the round divider or progress label beyond what's in the CSS. Keep it static.
- Do NOT reach into `extraBody` reuse / hoisting at any other call site — the existing `const extraBody = buildExtraBody(provider);` declaration above `runDispatchAgent` already exists in the baseline. We just remove the redundant inline `buildExtraBody(provider)` call inside the per-iteration `chatStream` payload (now uses `...extraBody`), and we delete the post-loop synthesis block that had its own `buildExtraBody(provider)` call.
- Do NOT ship persistence or migration code for the new `round` / `progress` / `awaitingResponse` fields. They are all marked optional in the type interfaces; older saved sessions just have them missing and the UI handles `undefined` gracefully (no divider, no progress label, no thinking indicator past completion).
