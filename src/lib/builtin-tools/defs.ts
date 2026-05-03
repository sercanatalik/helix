/* helix-ai · built-in tool catalogue.
 *
 * Pure declarations: the JSON schemas the model sees, the popover layout,
 * and the slash commands the composer handles directly. No runtime
 * dependencies — both the dispatcher (`./dispatcher`) and the popover
 * (`features/chat/builtin-palette`) consume this list.
 */

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
export type BuiltinToolGroup = "file_system" | "data" | "web";

export const BUILTIN_GROUP_LABEL: Readonly<Record<BuiltinToolGroup, string>> = {
  file_system: "File System",
  data: "Data Tools",
  web: "Web",
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
  {
    name: "web_search",
    label: "Web Search",
    group: "web",
    description:
      "Search the public web via DuckDuckGo. Returns up to 8 results (title, URL, snippet) by default; cap with `limit` (max 25). Goes through the user's corporate proxy when one is configured in Settings → Proxy. Use this when the user asks for recent information, citations, or anything that requires up-to-date sources outside the model's training data.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language search query. Same input you'd type into a search engine.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Cap on results returned. Default 8.",
        },
        region: {
          type: "string",
          description:
            "Optional DuckDuckGo region code (`us-en`, `uk-en`, `de-de`, …). Omit for the global default.",
        },
      },
      required: ["query"],
    },
  },
];

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_TOOLS.map((t) => t.name),
);

export function isBuiltinTool(name: string): boolean {
  return BUILTIN_TOOL_NAMES.has(name);
}
