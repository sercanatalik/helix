import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppView,
  DesktopAppState,
  McpCallToolResult,
  McpPromptResult,
  McpResourceResult,
  McpServerConfig,
  McpServerInput,
  McpTestResult,
} from "../app/types";
import type { ThemeId } from "../themes";

export interface TreeEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "folder" | "file";
  readonly depth: number;
  /** File size in bytes; undefined for folders. */
  readonly size?: number;
}

// -- Built-in tools (Read / Write / Edit / Glob / Grep) -----------------
//
// These mirror the canonical Claude Code tool set. The renderer can call
// them directly when no MCP server is providing equivalent capabilities.

export type ReadFileKind = "text" | "image" | "pdf" | "notebook";

export interface ReadFileResult {
  readonly kind: ReadFileKind;
  /** For `text` / `notebook`: the (possibly windowed) UTF-8 body, with line
   * numbers prepended in `cat -n` style for text. For `image` / `pdf`: a
   * base64-encoded `data:` URL ready to drop into an `<img src>`. */
  readonly content: string;
  /** Total line count of the underlying file when known (text only). */
  readonly totalLines?: number;
  /** Detected MIME type for non-text reads. */
  readonly mimeType?: string;
  readonly size: number;
}

export interface ReadFileOptions {
  /** 0-indexed first line to include. Omit to start from the top. */
  readonly offset?: number;
  /** Number of lines to include. Defaults to 2000. */
  readonly limit?: number;
}

export interface ReadPdfResult {
  readonly path: string;
  /** Extracted text. Pages are separated by `` (form-feed) — most
   * markdown renderers ignore it, the model can still see the boundary. */
  readonly text: string;
  readonly size: number;
  /** True when the extractor clipped the body at the 500 KB size cap. */
  readonly truncated: boolean;
}

export interface WriteFileResult {
  readonly path: string;
  readonly bytesWritten: number;
  readonly created: boolean;
}

export interface EditFileOptions {
  /** When true, replace every occurrence; otherwise the call fails unless
   * `oldString` is unique in the file. */
  readonly replaceAll?: boolean;
}

export interface EditFileResult {
  readonly path: string;
  readonly replacements: number;
}

export interface GlobMatch {
  readonly path: string;
  readonly modifiedMs?: number;
}

export type GrepMode = "files" | "content" | "count";

export interface GrepArgs {
  readonly pattern: string;
  readonly path?: string;
  /** Optional secondary glob restricting which files are searched. */
  readonly glob?: string;
  /** Defaults to `files` (just the list of matching paths). */
  readonly mode?: GrepMode;
  readonly caseInsensitive?: boolean;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  readonly headLimit?: number;
}

export interface GrepFileMatch {
  readonly path: string;
}

export interface GrepLineHit {
  readonly line: number;
  readonly text: string;
  readonly isMatch: boolean;
}

export interface GrepContentMatch {
  readonly path: string;
  readonly matches: readonly GrepLineHit[];
}

export interface GrepCountMatch {
  readonly path: string;
  readonly count: number;
}

export type GrepResult =
  | { readonly kind: "Files"; readonly matches: readonly GrepFileMatch[] }
  | { readonly kind: "Content"; readonly matches: readonly GrepContentMatch[] }
  | { readonly kind: "Count"; readonly matches: readonly GrepCountMatch[] };

export interface SearchFilesArgs {
  readonly pattern: string;
  readonly path?: string;
  readonly mode?: "files" | "content" | "count";
  readonly glob?: string;
  /** ripgrep file-type filter (`--type rust`, `--type ts`, …). */
  readonly fileType?: string;
  readonly caseInsensitive?: boolean;
  /** Treat pattern as literal (`-F`). */
  readonly fixedStrings?: boolean;
  /** Allow `.` to match newlines (`-U --multiline-dotall`). */
  readonly multiline?: boolean;
  readonly includeHidden?: boolean;
  /** Per-file match cap (`--max-count`). */
  readonly maxCount?: number;
  /** Total result cap. Default 1000. */
  readonly headLimit?: number;
  readonly contextBefore?: number;
  readonly contextAfter?: number;
}

export interface SearchCountMatch {
  readonly path: string;
  readonly count: number;
}

export interface SearchContentLine {
  readonly line: number;
  readonly text: string;
  readonly isMatch: boolean;
}

export interface SearchContentFile {
  readonly path: string;
  readonly matches: readonly SearchContentLine[];
}

export type SearchFilesResult =
  | { readonly kind: "Files"; readonly matches: readonly string[] }
  | { readonly kind: "Count"; readonly matches: readonly SearchCountMatch[] }
  | {
      readonly kind: "Content";
      readonly matches: readonly SearchContentFile[];
    };

// -- Data tools (Polars / calamine) -------------------------------------
//
// `read_excel` parses a workbook into an in-Rust DataFrame and returns a
// preview + handle. `analyse_data` then operates on that handle (and any
// derived handles it produces). DataFrames live in the Rust process under
// LRU eviction — the renderer never sees the raw frame, just metadata and
// a head sample.

export interface DataColumnInfo {
  readonly name: string;
  readonly dtype: string;
}

export type DataPreviewRow = Readonly<Record<string, unknown>>;

export interface ReadExcelResult {
  readonly handle: string;
  readonly path: string;
  readonly sheet: string;
  readonly sheetNames: readonly string[];
  readonly shape: readonly [number, number];
  readonly columns: readonly DataColumnInfo[];
  readonly preview: readonly DataPreviewRow[];
}

export interface ReadExcelOptions {
  /** Sheet name to load. Defaults to the first sheet. */
  readonly sheet?: string;
  /** When true (default) the first row supplies column names. */
  readonly hasHeader?: boolean;
}

export interface AggSpec {
  readonly column: string;
  readonly op:
    | "count"
    | "sum"
    | "mean"
    | "avg"
    | "median"
    | "min"
    | "max"
    | "std"
    | "var"
    | "n_unique"
    | "nunique"
    | "first"
    | "last";
  readonly alias?: string;
}

export type AnalyseOp =
  | { readonly kind: "describe" }
  | { readonly kind: "head"; readonly n?: number }
  | { readonly kind: "tail"; readonly n?: number }
  | { readonly kind: "schema" }
  | { readonly kind: "select"; readonly columns: readonly string[] }
  | {
      readonly kind: "filter";
      readonly column: string;
      /** Comparison op: ==, !=, >, >=, <, <=, contains, starts_with,
       * ends_with, is_null, not_null. */
      readonly op: string;
      readonly value?: unknown;
    }
  | {
      readonly kind: "sort";
      readonly by: readonly string[];
      readonly descending?: readonly boolean[];
    }
  | {
      readonly kind: "group_by";
      readonly by: readonly string[];
      readonly agg: readonly AggSpec[];
    }
  | {
      readonly kind: "pivot";
      readonly index: readonly string[];
      readonly on: readonly string[];
      readonly values: readonly string[];
      /** Aggregation when (index, on) duplicates land in the same cell.
       * Defaults to `mean`. */
      readonly agg?: "first" | "last" | "sum" | "min" | "max" | "mean" | "avg" | "median" | "count";
    }
  | { readonly kind: "unique"; readonly column: string }
  | { readonly kind: "value_counts"; readonly column: string };

export interface AnalyseResult {
  readonly sourceHandle: string;
  readonly operation: string;
  /** New handle for the derived DataFrame; absent for read-only ops like
   * `schema`. Pass it back as `handle` to chain another `analyseData` call. */
  readonly handle?: string;
  readonly shape: readonly [number, number];
  readonly columns: readonly DataColumnInfo[];
  readonly preview: readonly DataPreviewRow[];
}

const STATE_CHANGED_EVENT = "helix://state-changed";

export const helixApi = {
  ping: (): Promise<string> => invoke<string>("ping"),
  getState: (): Promise<DesktopAppState> => invoke<DesktopAppState>("get_state"),
  setTheme: (theme: ThemeId): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_theme", { theme }),
  setActiveView: (view: AppView): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_active_view", { view }),
  listWorkspaceTree: (path: string): Promise<TreeEntry[]> =>
    invoke<TreeEntry[]>("list_workspace_tree", { path }),
  watchWorkspace: (path: string): Promise<void> =>
    invoke<void>("watch_workspace", { path }),
  unwatchWorkspace: (): Promise<void> => invoke<void>("unwatch_workspace"),

  /**
   * Subscribe to push updates of the full app state. The Rust side emits a
   * snapshot whenever an MCP server's runtime status changes (connecting →
   * connected → error etc.) so the UI can reflect connection state without
   * polling. Returns an unsubscribe function; safe to call before the Tauri
   * runtime is ready (a noop until the listener attaches).
   */
  onStateChanged: (
    listener: (state: DesktopAppState) => void,
  ): (() => void) => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<DesktopAppState>(STATE_CHANGED_EVENT, (event) =>
      listener(event.payload),
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  // -- MCP ----------------------------------------------------------------
  //
  // Surface mirrors gcf-desktop's `piApp` so an MCP UI built against either
  // backend works the same way. Mutations return the post-write snapshot;
  // long-running effects (connect/disconnect) land on `helix://state-changed`.

  addMcpServer: (input: McpServerInput): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("add_mcp_server", { input }),

  updateMcpServer: (
    id: string,
    patch: Partial<McpServerInput>,
  ): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("update_mcp_server", { id, patch }),

  removeMcpServer: (id: string): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("remove_mcp_server", { id }),

  /** Force a disconnect-and-reconnect cycle. Use after editing a server's
   * URL or command — `update_mcp_server` already triggers a sync, this is
   * for the "Save & reconnect" button that bypasses the change-hash check. */
  reconnectMcpServer: (id: string): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("reconnect_mcp_server", { id }),

  setMcpToolEnabled: (
    serverId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_mcp_tool_enabled", {
      serverId,
      toolName,
      enabled,
    }),

  /** Toggle a prompt's persistent "inject as hidden system context every
   * message" flag. Opt-in: prompts default to off because auto-prepending
   * everything a server advertises would balloon the model's context. */
  setMcpPromptEnabled: (
    serverId: string,
    promptName: string,
    enabled: boolean,
  ): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_mcp_prompt_enabled", {
      serverId,
      promptName,
      enabled,
    }),

  callMcpPrompt: (
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<McpPromptResult> =>
    invoke<McpPromptResult>("call_mcp_prompt", { serverId, name, args }),

  readMcpResource: (
    serverId: string,
    uri: string,
  ): Promise<McpResourceResult> =>
    invoke<McpResourceResult>("read_mcp_resource", { serverId, uri }),

  /** Invoke a tool on a connected MCP server. `args` should match the tool's
   * `inputSchema` (advertised on `McpServerRuntime.tools`). The agent loop is
   * the primary caller — UI surfaces should rarely need this directly. */
  callMcpTool: (
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> =>
    invoke<McpCallToolResult>("call_mcp_tool", { serverId, toolName, args }),

  /** One-shot connection test for a draft MCP server input. Opens a fresh
   * transport, runs the handshake + discovery calls, then drops the
   * connection. Doesn't touch the persistent server list — safe to call from
   * the form before saving. */
  testMcpServer: (input: McpServerInput): Promise<McpTestResult> =>
    invoke<McpTestResult>("test_mcp_server", { input }),

  // -- Skills -------------------------------------------------------------
  //
  // Claude Desktop / Claude Code parity: the backend watches
  // `~/.claude/skills` and `<workspace>/.claude/skills`, parses each
  // `SKILL.md`, and emits the merged list via `helix://state-changed`. The
  // commands below let the frontend retarget the project root, force a
  // rescan, and render a skill body for invocation.

  /** Update the workspace whose `.claude/skills` directory should be
   * watched. Pass `undefined` (or an empty string) when no workspace is
   * active. Returns the post-update snapshot synchronously; subsequent
   * filesystem changes arrive on `helix://state-changed`. */
  setSkillsWorkspace: (workspace: string | undefined): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_skills_workspace", { workspace }),

  /** Force a manual rescan of every skills root. Useful when the user has
   * just created `.claude/skills/` for the first time — the watcher needs
   * an existing directory to fire on. */
  reloadSkills: (): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("reload_skills"),

  /** Render a skill into the string the chat view should send as a hidden
   * system message. Substitutes `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, and
   * named placeholders (declared in the frontmatter `arguments` list)
   * following Claude Code's rules. */
  renderSkill: (
    skillId: string,
    args: string,
  ): Promise<string> =>
    invoke<string>("render_skill", { skillId, arguments: args }),

  // -- Built-in tools ----------------------------------------------------
  //
  // Reach the Rust-side Read / Write / Edit / Glob / Grep implementations
  // — the in-process equivalents of the canonical Claude Code tools. None
  // of these touch state; they're side effects against the user's local
  // filesystem and report back synchronously.

  /** Read a file. Text files come back as a `cat -n`-style numbered slice
   * (default 2000 lines from the top); images/PDFs come back as a base64
   * data URL. Notebooks are flattened cell-by-cell into a text body. */
  readFile: (
    path: string,
    options?: ReadFileOptions,
  ): Promise<ReadFileResult> =>
    invoke<ReadFileResult>("read_file", {
      path,
      offset: options?.offset,
      limit: options?.limit,
    }),

  /** Extract plain text from a PDF using the pure-Rust pdf-extract
   * pipeline. Best-effort on scanned / image-only PDFs (returns the
   * embedded text layer only — there's no OCR). Hard-capped at 50 MB
   * input and 500 KB output. */
  readPdf: (path: string): Promise<ReadPdfResult> =>
    invoke<ReadPdfResult>("read_pdf", { path }),

  /** Create or overwrite a file. Missing parent directories are created. */
  writeFile: (path: string, content: string): Promise<WriteFileResult> =>
    invoke<WriteFileResult>("write_file", { path, content }),

  /** Replace `oldString` with `newString` in an existing file. Without
   * `replaceAll`, the call fails when `oldString` appears more than once —
   * pass a longer excerpt or set the flag to opt into multi-replace. */
  editFile: (
    path: string,
    oldString: string,
    newString: string,
    options?: EditFileOptions,
  ): Promise<EditFileResult> =>
    invoke<EditFileResult>("edit_file", {
      path,
      oldString,
      newString,
      replaceAll: options?.replaceAll ?? false,
    }),

  /** Match files by glob pattern. Patterns join with `cwd` when relative;
   * results are sorted newest-first by mtime. */
  globFiles: (pattern: string, cwd?: string): Promise<GlobMatch[]> =>
    invoke<GlobMatch[]>("glob_files", { pattern, cwd }),

  /** Regex search across files in a directory. Honours `.gitignore` by
   * default — pass an explicit `glob` to narrow further. The `mode` field
   * picks between filename-only, line-by-line content, or per-file counts. */
  grepSearch: (args: GrepArgs): Promise<GrepResult> =>
    invoke<GrepResult>("grep_search", { args }),

  /** Search files via the actual ripgrep binary on PATH. Exposes the full
   * `rg` feature surface (file-type filters, multiline regex, hidden-file
   * handling, fixed-string mode). Falls through with a clear install hint
   * when `rg` isn't found. */
  searchFiles: (args: SearchFilesArgs): Promise<SearchFilesResult> =>
    invoke<SearchFilesResult>("search_files", {
      args: {
        pattern: args.pattern,
        path: args.path,
        mode: args.mode,
        glob: args.glob,
        fileType: args.fileType,
        caseInsensitive: args.caseInsensitive,
        fixedStrings: args.fixedStrings,
        multiline: args.multiline,
        includeHidden: args.includeHidden,
        maxCount: args.maxCount,
        headLimit: args.headLimit,
        contextBefore: args.contextBefore,
        contextAfter: args.contextAfter,
      },
    }),

  /** Load an Excel / ODS workbook into an in-Rust Polars DataFrame.
   * Returns a handle plus a small preview; pass the handle to
   * {@link analyseData} for downstream operations. */
  readExcel: (
    path: string,
    options?: ReadExcelOptions,
  ): Promise<ReadExcelResult> =>
    invoke<ReadExcelResult>("read_excel", {
      path,
      sheet: options?.sheet,
      hasHeader: options?.hasHeader,
    }),

  /** Run a single statistical operation against a DataFrame handle. The
   * operation produces a derived DataFrame (filter/sort/group_by/pivot/
   * select/describe/...) that's stored under a fresh handle so chains
   * stay cheap to express. */
  analyseData: (handle: string, op: AnalyseOp): Promise<AnalyseResult> =>
    invoke<AnalyseResult>("analyse_data", {
      args: { handle, operation: op },
    }),
};

export type HelixApi = typeof helixApi;

// Re-export the McpServerConfig type for callers that import the API module
// — saves a second import of `../app/types` for UI components that operate
// on a server record returned by these methods.
export type { McpServerConfig };
