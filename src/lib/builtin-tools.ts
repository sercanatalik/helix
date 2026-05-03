/* helix-ai · built-in tools.
 *
 * The Rust backend exposes Read / Write / Edit / Glob / Grep as Tauri
 * commands; this module turns them into model-callable tools that ride the
 * same agent loop as MCP tools. The composer surfaces them in a popover and
 * `useChat` routes calls through the dispatcher below when it sees the
 * sentinel server id.
 *
 * Naming: tool names match the Tauri command names (`read_file` etc.) so
 * the model and the dispatcher agree on a single string. The user-facing
 * label (`Read`, `Write`, …) lives only in the popover.
 */

import { useCallback, useEffect, useState } from "react";

/** Sentinel `serverId` used on every BuiltinToolBinding. `useChat` checks
 * for this value and routes to {@link runBuiltinTool} instead of the MCP
 * transport. Picked to avoid colliding with `mcp_<uuid>` server ids. */
export const BUILTIN_SERVER_ID = "__builtin__";
/** Display name shown in the chip / popover header. */
export const BUILTIN_SERVER_NAME = "Built-in";

/** UI handlers some built-in tools need to reach back into React. The
 * composer registers its callbacks on mount; the dispatcher reads them
 * when a tool that needs them fires. Module-level registry rather than
 * threading callbacks through the agent loop — `useChat` doesn't know
 * about UI affordances and shouldn't have to. */
interface BuiltinUiHandlers {
  /** Clear the visible transcript and reset model-side context. Used by
   * the `clear` built-in tool and the `/clear` slash command — both are
   * "hard" resets. The context-usage chip uses a separate, soft reset
   * that only forgets old messages on the model side. */
  clearTranscript?: () => void;
  /** Active workspace's attached folder. When set, relative paths handed
   * to file-system tools are resolved against it, and search tools that
   * take a root default to it. Empty/unset means "no workspace folder" —
   * the dispatcher then leaves paths verbatim and the process CWD wins. */
  workspacePath?: string;
}
const uiHandlers: BuiltinUiHandlers = {};

/** Read the currently-attached workspace folder, if any. Surfaced for the
 * composer's system-context injection so the model is told where it is. */
export function getBuiltinWorkspacePath(): string | undefined {
  const p = uiHandlers.workspacePath;
  return p && p.length > 0 ? p : undefined;
}

/** True when `p` looks absolute on either Unix or Windows. Cheap heuristic
 * — we don't need to resolve symlinks, just decide whether to prepend the
 * workspace folder. */
function isAbsolutePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return true;
  // Windows drive-letter path: C:\foo, c:/foo, …
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/** Join a possibly-relative path against the active workspace folder.
 * Absolute paths and `~`-expanded paths pass through unchanged. Returns
 * the input verbatim when no workspace is attached so the legacy
 * "process CWD" behaviour is preserved for users who haven't picked one. */
function resolveAgainstWorkspace(path: string): string {
  if (!path) return path;
  if (isAbsolutePath(path)) return path;
  if (path.startsWith("~")) return path; // shell tilde — leave for the OS
  const ws = uiHandlers.workspacePath;
  if (!ws) return path;
  const sep = /[\\/]$/.test(ws) ? "" : "/";
  return `${ws}${sep}${path}`;
}

/** Register the React-side callbacks the dispatcher can invoke. Pass
 * `undefined` to clear a slot (e.g. on unmount). The composer wires this
 * up via `useEffect`. */
export function setBuiltinUiHandlers(next: BuiltinUiHandlers): void {
  Object.assign(uiHandlers, next);
}

/** User-typed slash commands that the composer handles directly — they
 * never round-trip to the model. Distinct from {@link BUILTIN_TOOLS},
 * which the model invokes; these are textarea shortcuts. They surface
 * in the slash popover next to skills and short-circuit `submit()`. */
export interface BuiltinSlashCommand {
  readonly name: string;
  readonly description: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = [
  {
    name: "clear",
    description:
      "Clear the visible chat transcript and reset the model's context. The conversation starts fresh.",
  },
  {
    name: "write-to-workspace",
    description:
      "Save the assistant responses as a markdown file in the active workspace folder with short summaries. Tables, code fences, and chart specs are preserved verbatim; only a short header (title + timestamp) is prepended.",
  },
];

/** Subgroups inside the Helix Core popover — mirror the MCP popover's
 * tag-bucket layout so each kind of capability gets its own master switch. */
export type BuiltinToolGroup = "file_system" | "data";

export const BUILTIN_GROUP_LABEL: Readonly<Record<BuiltinToolGroup, string>> = {
  file_system: "File System",
  data: "Data Tools",
};

export interface BuiltinToolDef {
  /** Tool name as the model sees it. Matches the Tauri command name. */
  readonly name: string;
  /** Capitalized display label for the popover row. */
  readonly label: string;
  /** Short blurb shown beside the label and forwarded to the model. */
  readonly description: string;
  /** OpenAI-style JSON schema for the model's `function.parameters`. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Subgroup the tool belongs to inside the popover. */
  readonly group: BuiltinToolGroup;
}

/** The full catalogue. Order here is the order in the popover — read/write
 * /edit are the most common, glob/grep follow. */
export const BUILTIN_TOOLS: readonly BuiltinToolDef[] = [
  {
    name: "read_file",
    label: "Read",
    group: "file_system",
    description:
      "Read the contents of a file from the local filesystem. Supports text, images, PDFs, and Jupyter notebooks. Text comes back with line numbers prepended (cat -n style). Use offset/limit to window into long files. Relative paths are resolved against the active workspace folder when one is attached.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file to read. Absolute, or relative to the active workspace folder.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "0-indexed first line to include (text only). Default 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Number of lines to include (text only). Default 2000.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "clear",
    label: "Clear",
    group: "file_system",
    description:
      "Clear the visible chat transcript and reset the model's context. After this fires, both the UI and the model see an empty conversation. Use when the user asks to start over or wipe history. Equivalent to the user typing /clear.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf",
    label: "Read PDF",
    group: "file_system",
    description:
      "Extract plain text from a PDF using a pure-Rust extractor. Pages are separated by form-feed characters. Best-effort on scanned / image-only PDFs (no OCR — only the embedded text layer is returned). Capped at 50 MB input and 500 KB output. Relative paths resolve against the active workspace folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the PDF file. Absolute, or relative to the active workspace folder.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    label: "Write",
    group: "file_system",
    description:
      "Create or overwrite a file at the given path. Missing parent directories are created automatically. Use Edit for surgical changes; this overwrites the whole file. When the user has attached a workspace folder, relative paths are resolved inside that folder — prefer relative paths so files land in the user's workspace by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file to create or replace. Absolute, or relative to the active workspace folder. Prefer relative paths when a workspace is attached so the file lands inside it.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 contents to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    label: "Edit",
    group: "file_system",
    description:
      "Replace one (or all) occurrences of `old_string` with `new_string` in an existing file. Without `replace_all`, the call fails when `old_string` is not unique — supply a longer excerpt or set replace_all=true. Relative paths resolve against the active workspace folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the file to modify. Absolute, or relative to the active workspace folder.",
        },
        old_string: {
          type: "string",
          description: "Exact text to find. Must be unique unless replace_all is true.",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "When true, replace every occurrence. Default false (single, unique replacement).",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "glob_files",
    label: "Glob",
    group: "file_system",
    description:
      "Find files matching a glob pattern (e.g. `**/*.ts`, `src/**/*.py`). Results come back sorted newest-first by modification time. Supply `cwd` to anchor relative patterns; defaults to the active workspace folder when one is attached.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern. Supports `*`, `**`, `?`, character classes.",
        },
        cwd: {
          type: "string",
          description:
            "Directory to anchor relative patterns. Defaults to the process working directory.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    label: "Grep",
    group: "file_system",
    description:
      "Regex search across files. Honours .gitignore by default. `mode` picks between filename-only matches (`files`), line-by-line content with optional context, or per-file counts. The search root defaults to the active workspace folder when one is attached.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regular expression (Rust regex flavour). Prepend `(?i)` for case-insensitive.",
        },
        path: {
          type: "string",
          description: "Search root. Defaults to the process working directory.",
        },
        glob: {
          type: "string",
          description:
            "Optional glob restricting which files to search (e.g. `**/*.{ts,tsx}`).",
        },
        mode: {
          type: "string",
          enum: ["files", "content", "count"],
          description: "Result shape. Default `files`.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Equivalent to prepending `(?i)` to the pattern.",
        },
        context_before: {
          type: "integer",
          minimum: 0,
          description:
            "Lines of context emitted before each match in `content` mode.",
        },
        context_after: {
          type: "integer",
          minimum: 0,
          description:
            "Lines of context emitted after each match in `content` mode.",
        },
        head_limit: {
          type: "integer",
          minimum: 1,
          description: "Cap on total results. Default 1000.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_files",
    label: "Search Files",
    group: "file_system",
    description:
      "High-performance code search via the ripgrep binary on PATH. Honours .gitignore by default. Supports file-type filters (--type rust|ts|py|...), multiline regex, fixed-string mode, and hidden-file inclusion. Modes: `files` (default — list of paths), `content` (path:line:text with optional context), or `count` (per-file match counts). The search root defaults to the active workspace folder when one is attached.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Regex pattern. Same flavour as ripgrep (Rust regex). Prepend `(?i)` or set caseInsensitive for case-insensitive.",
        },
        path: {
          type: "string",
          description:
            "Search root. Defaults to the process working directory.",
        },
        mode: {
          type: "string",
          enum: ["files", "content", "count"],
          description: "Result shape. Default `files`.",
        },
        glob: {
          type: "string",
          description:
            "Optional glob — supports include / `!exclude` (e.g. `**/*.rs`, `!**/target/**`).",
        },
        fileType: {
          type: "string",
          description:
            "ripgrep file-type filter (`rust`, `ts`, `py`, `go`, …). See `rg --type-list`.",
        },
        caseInsensitive: { type: "boolean" },
        fixedStrings: {
          type: "boolean",
          description: "Treat pattern as literal text instead of regex.",
        },
        multiline: {
          type: "boolean",
          description: "Allow `.` to match newlines and patterns to span lines.",
        },
        includeHidden: { type: "boolean" },
        maxCount: {
          type: "integer",
          minimum: 1,
          description: "Per-file match cap (`--max-count`).",
        },
        headLimit: {
          type: "integer",
          minimum: 1,
          description: "Total result cap. Default 1000.",
        },
        contextBefore: {
          type: "integer",
          minimum: 0,
          description: "Lines of context before each hit (content mode).",
        },
        contextAfter: {
          type: "integer",
          minimum: 0,
          description: "Lines of context after each hit (content mode).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_excel",
    label: "Read Excel",
    group: "data",
    description:
      "Load an Excel / ODS / XLS workbook into a Polars DataFrame. Returns a handle plus a 10-row preview and column dtypes. Pass the handle to analyse_data for grouping, pivoting, filtering, sorting, and summary statistics. Relative paths resolve against the active workspace folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the workbook (.xlsx, .xls, .ods). Absolute, or relative to the active workspace folder.",
        },
        sheet: {
          type: "string",
          description:
            "Sheet name to load. Defaults to the first sheet in the workbook.",
        },
        has_header: {
          type: "boolean",
          description:
            "When true (default) the first row supplies column names; otherwise columns are auto-named col_0, col_1, …",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "analyse_data",
    label: "Analyse Data",
    group: "data",
    description:
      "Run one statistical operation against a DataFrame handle (from read_excel or a previous analyse_data call). Each call returns a new handle so you can chain. Operations: describe, head, tail, schema, select, filter, sort, group_by, pivot, unique, value_counts.",
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "DataFrame handle returned by read_excel or analyse_data.",
        },
        operation: {
          type: "object",
          description:
            "Operation envelope. Discriminated by `kind`. Examples: { kind: 'describe' }, { kind: 'head', n: 5 }, { kind: 'filter', column: 'region', op: '==', value: 'us' }, { kind: 'group_by', by: ['region'], agg: [{ column: 'sales', op: 'sum' }] }, { kind: 'pivot', index: ['region'], on: ['quarter'], values: ['sales'], agg: 'sum' }, { kind: 'sort', by: ['sales'], descending: [true] }, { kind: 'value_counts', column: 'region' }.",
          properties: {
            kind: {
              type: "string",
              enum: [
                "describe",
                "head",
                "tail",
                "schema",
                "select",
                "filter",
                "sort",
                "group_by",
                "pivot",
                "unique",
                "value_counts",
              ],
            },
          },
          required: ["kind"],
        },
      },
      required: ["handle", "operation"],
    },
  },
];

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_TOOLS.map((t) => t.name),
);

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name);
}

/** Run a built-in tool by name. Returns the same `{ result, isError }`
 * shape `useChat` expects from MCP tool calls so the agent loop stays
 * uniform regardless of which transport produced the result. */
export async function runBuiltinTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  try {
    switch (name) {
      case "read_file": {
        const { path, offset, limit } = args as {
          path?: string;
          offset?: number;
          limit?: number;
        };
        if (typeof path !== "string" || !path) {
          return { result: "read_file: missing `path`", isError: true };
        }
        const resolved = resolveAgainstWorkspace(path);
        const r = await window.helixApi.readFile(resolved, { offset, limit });
        // Image / PDF reads come back as data URLs — relay verbatim so the
        // model can include them in its tool result and a downstream
        // markdown image renderer can pick them up. Notebooks and text both
        // arrive as plain text, so concatenation is enough.
        if (r.kind === "image" || r.kind === "pdf") {
          return {
            result: `Binary ${r.kind} (${r.size} bytes, ${r.mimeType ?? "?"}):\n${r.content}`,
            isError: false,
          };
        }
        const headerLines: string[] = [];
        if (typeof r.totalLines === "number") {
          headerLines.push(`Total lines: ${r.totalLines}`);
        }
        const header = headerLines.length > 0 ? `${headerLines.join("\n")}\n\n` : "";
        return { result: `${header}${r.content}`, isError: false };
      }
      case "clear": {
        if (!uiHandlers.clearTranscript) {
          return {
            result:
              "clear: no active chat to clear (UI handler not registered).",
            isError: true,
          };
        }
        uiHandlers.clearTranscript();
        return {
          result:
            "Chat transcript cleared. The conversation has been reset.",
          isError: false,
        };
      }
      case "read_pdf": {
        const { path } = args as { path?: string };
        if (typeof path !== "string" || !path) {
          return { result: "read_pdf: missing `path`", isError: true };
        }
        const resolved = resolveAgainstWorkspace(path);
        const r = await window.helixApi.readPdf(resolved);
        const header = `PDF: ${r.path} (${r.size} bytes)${r.truncated ? " — truncated" : ""}`;
        return { result: `${header}\n\n${r.text}`, isError: false };
      }
      case "write_file": {
        const { path, content } = args as {
          path?: string;
          content?: string;
        };
        if (typeof path !== "string" || !path) {
          return { result: "write_file: missing `path`", isError: true };
        }
        if (typeof content !== "string") {
          return { result: "write_file: missing `content`", isError: true };
        }
        const resolved = resolveAgainstWorkspace(path);
        const r = await window.helixApi.writeFile(resolved, content);
        return {
          result: `${r.created ? "Created" : "Updated"} ${r.path} (${r.bytesWritten} bytes)`,
          isError: false,
        };
      }
      case "edit_file": {
        const { path, old_string, new_string, replace_all } = args as {
          path?: string;
          old_string?: string;
          new_string?: string;
          replace_all?: boolean;
        };
        if (typeof path !== "string" || !path) {
          return { result: "edit_file: missing `path`", isError: true };
        }
        if (typeof old_string !== "string" || typeof new_string !== "string") {
          return {
            result: "edit_file: `old_string` and `new_string` are required",
            isError: true,
          };
        }
        const resolved = resolveAgainstWorkspace(path);
        const r = await window.helixApi.editFile(resolved, old_string, new_string, {
          replaceAll: !!replace_all,
        });
        return {
          result: `Replaced ${r.replacements} occurrence(s) in ${r.path}`,
          isError: false,
        };
      }
      case "glob_files": {
        const { pattern, cwd } = args as { pattern?: string; cwd?: string };
        if (typeof pattern !== "string" || !pattern) {
          return { result: "glob_files: missing `pattern`", isError: true };
        }
        // No cwd given → anchor to the workspace folder when one's attached
        // so a `**/*.ts` from the model lines up with what the user sees in
        // the right-hand panel. Falls through to process CWD otherwise.
        const effectiveCwd = cwd ?? uiHandlers.workspacePath;
        const matches = await window.helixApi.globFiles(pattern, effectiveCwd);
        if (matches.length === 0) {
          return {
            result: `No files matched: ${pattern}`,
            isError: false,
          };
        }
        return {
          result: matches.map((m) => m.path).join("\n"),
          isError: false,
        };
      }
      case "grep_search": {
        const a = args as Record<string, unknown>;
        const rawPath = typeof a.path === "string" ? a.path : undefined;
        const r = await window.helixApi.grepSearch({
          pattern: String(a.pattern ?? ""),
          path: rawPath
            ? resolveAgainstWorkspace(rawPath)
            : uiHandlers.workspacePath,
          glob: typeof a.glob === "string" ? a.glob : undefined,
          mode:
            a.mode === "content" || a.mode === "count" ? a.mode : "files",
          caseInsensitive: !!a.case_insensitive,
          contextBefore:
            typeof a.context_before === "number" ? a.context_before : 0,
          contextAfter:
            typeof a.context_after === "number" ? a.context_after : 0,
          headLimit:
            typeof a.head_limit === "number" ? a.head_limit : undefined,
        });
        return { result: formatGrepResult(r), isError: false };
      }
      case "search_files": {
        const a = args as Record<string, unknown>;
        const rawPath = typeof a.path === "string" ? a.path : undefined;
        const r = await window.helixApi.searchFiles({
          pattern: String(a.pattern ?? ""),
          path: rawPath
            ? resolveAgainstWorkspace(rawPath)
            : uiHandlers.workspacePath,
          mode:
            a.mode === "content" || a.mode === "count" ? a.mode : "files",
          glob: typeof a.glob === "string" ? a.glob : undefined,
          fileType:
            typeof a.file_type === "string"
              ? a.file_type
              : typeof a.fileType === "string"
                ? a.fileType
                : undefined,
          caseInsensitive: !!(a.case_insensitive ?? a.caseInsensitive),
          fixedStrings: !!(a.fixed_strings ?? a.fixedStrings),
          multiline: !!a.multiline,
          includeHidden: !!(a.include_hidden ?? a.includeHidden),
          maxCount:
            typeof a.max_count === "number"
              ? a.max_count
              : typeof a.maxCount === "number"
                ? a.maxCount
                : undefined,
          headLimit:
            typeof a.head_limit === "number"
              ? a.head_limit
              : typeof a.headLimit === "number"
                ? a.headLimit
                : undefined,
          contextBefore:
            typeof a.context_before === "number"
              ? a.context_before
              : typeof a.contextBefore === "number"
                ? a.contextBefore
                : undefined,
          contextAfter:
            typeof a.context_after === "number"
              ? a.context_after
              : typeof a.contextAfter === "number"
                ? a.contextAfter
                : undefined,
        });
        return { result: formatSearchFilesResult(r), isError: false };
      }
      case "read_excel": {
        const { path, sheet, has_header } = args as {
          path?: string;
          sheet?: string;
          has_header?: boolean;
        };
        if (typeof path !== "string" || !path) {
          return { result: "read_excel: missing `path`", isError: true };
        }
        const resolved = resolveAgainstWorkspace(path);
        const r = await window.helixApi.readExcel(resolved, {
          sheet,
          hasHeader: typeof has_header === "boolean" ? has_header : undefined,
        });
        return { result: formatDataResult(r), isError: false };
      }
      case "analyse_data": {
        const { handle, operation } = args as {
          handle?: string;
          operation?: unknown;
        };
        if (typeof handle !== "string" || !handle) {
          return { result: "analyse_data: missing `handle`", isError: true };
        }
        const op = operation as
          | import("./tauri-api").AnalyseOp
          | undefined;
        if (!op || typeof op !== "object" || typeof op.kind !== "string") {
          return {
            result:
              "analyse_data: `operation` must be an object with a `kind` field",
            isError: true,
          };
        }
        const r = await window.helixApi.analyseData(handle, op);
        return { result: formatAnalyseResult(r), isError: false };
      }
      default:
        return {
          result: `Unknown built-in tool: ${name}`,
          isError: true,
        };
    }
  } catch (err) {
    return {
      result: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

function formatDataResult(
  r: import("./tauri-api").ReadExcelResult,
): string {
  const head = `Loaded ${r.path}\nsheet: ${r.sheet} (of ${r.sheetNames.length}: ${r.sheetNames.join(", ")})\nshape: ${r.shape[0]} rows × ${r.shape[1]} columns\nhandle: ${r.handle}`;
  return `${head}\n\nColumns:\n${formatColumns(r.columns)}\n\nPreview (first ${r.preview.length}):\n${formatPreviewRows(r.columns, r.preview)}`;
}

function formatAnalyseResult(
  r: import("./tauri-api").AnalyseResult,
): string {
  const head = [
    `operation: ${r.operation}`,
    `source: ${r.sourceHandle}`,
    r.handle ? `handle: ${r.handle}` : null,
    `shape: ${r.shape[0]} rows × ${r.shape[1]} columns`,
  ]
    .filter(Boolean)
    .join("\n");
  return `${head}\n\nColumns:\n${formatColumns(r.columns)}\n\nPreview (first ${r.preview.length}):\n${formatPreviewRows(r.columns, r.preview)}`;
}

function formatColumns(
  columns: readonly import("./tauri-api").DataColumnInfo[],
): string {
  return columns.map((c) => `  ${c.name}: ${c.dtype}`).join("\n");
}

function formatPreviewRows(
  columns: readonly import("./tauri-api").DataColumnInfo[],
  rows: readonly import("./tauri-api").DataPreviewRow[],
): string {
  if (rows.length === 0) return "(empty)";
  const header = columns.map((c) => c.name).join("\t");
  const body = rows
    .map((row) =>
      columns
        .map((c) => formatCell(row[c.name]))
        .join("\t"),
    )
    .join("\n");
  return `${header}\n${body}`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function formatSearchFilesResult(
  r: import("./tauri-api").SearchFilesResult,
): string {
  if (r.kind === "Files") {
    if (r.matches.length === 0) return "No matching files.";
    return r.matches.join("\n");
  }
  if (r.kind === "Count") {
    if (r.matches.length === 0) return "No matches.";
    return r.matches.map((m) => `${m.path}: ${m.count}`).join("\n");
  }
  if (r.matches.length === 0) return "No matches.";
  const blocks = r.matches.map((file) => {
    const rows = file.matches.map(
      (l) => `${file.path}:${l.line}:${l.isMatch ? "" : " "}${l.text}`,
    );
    return rows.join("\n");
  });
  return blocks.join("\n\n");
}

function formatGrepResult(
  r: import("./tauri-api").GrepResult,
): string {
  if (r.kind === "Files") {
    if (r.matches.length === 0) return "No matching files.";
    return r.matches.map((m) => m.path).join("\n");
  }
  if (r.kind === "Count") {
    if (r.matches.length === 0) return "No matches.";
    return r.matches.map((m) => `${m.path}: ${m.count}`).join("\n");
  }
  // Content mode — `path:line: text` per row, blank line between files so
  // the agent can scan visually.
  if (r.matches.length === 0) return "No matches.";
  const blocks = r.matches.map((file) => {
    const rows = file.matches.map(
      (l) => `${file.path}:${l.line}:${l.isMatch ? "" : " "}${l.text}`,
    );
    return rows.join("\n");
  });
  return blocks.join("\n\n");
}

// -- Per-app preferences --------------------------------------------------

const STORAGE_KEY = "helix.builtin-tools.disabled";

function readDisabled(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeDisabled(names: readonly string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // Quota / privacy mode — surface failures via the UI? For now the
    // toggle just doesn't persist. Better than crashing the composer.
  }
}

export interface UseBuiltinToolsResult {
  /** The full catalogue (always returns every tool). */
  readonly tools: readonly BuiltinToolDef[];
  /** True when the named tool should be advertised to the model. */
  readonly isEnabled: (name: string) => boolean;
  /** Names currently enabled — derived, sorted in catalogue order. */
  readonly enabledNames: readonly string[];
  readonly setEnabled: (name: string, enabled: boolean) => void;
  /** Bulk toggle. Shortcut for the "all on / all off" switch. */
  readonly setAllEnabled: (enabled: boolean) => void;
}

/** All built-in tools default to *enabled*. Storage persists the disabled
 * set rather than the enabled set so a future addition to the catalogue
 * automatically opts the user in (parity with the MCP `disabledTools`
 * pattern in the backend). */
export function useBuiltinTools(): UseBuiltinToolsResult {
  const [disabled, setDisabled] = useState<readonly string[]>(() =>
    readDisabled(),
  );

  useEffect(() => {
    writeDisabled(disabled);
  }, [disabled]);

  const isEnabled = useCallback(
    (name: string) => !disabled.includes(name),
    [disabled],
  );

  const setEnabled = useCallback((name: string, enabled: boolean) => {
    setDisabled((curr) => {
      if (enabled) {
        if (!curr.includes(name)) return curr;
        return curr.filter((n) => n !== name);
      }
      if (curr.includes(name)) return curr;
      return [...curr, name];
    });
  }, []);

  const setAllEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      setDisabled([]);
    } else {
      setDisabled(BUILTIN_TOOLS.map((t) => t.name));
    }
  }, []);

  const enabledNames = BUILTIN_TOOLS.map((t) => t.name).filter(
    (n) => !disabled.includes(n),
  );

  return {
    tools: BUILTIN_TOOLS,
    isEnabled,
    enabledNames,
    setEnabled,
    setAllEnabled,
  };
}
