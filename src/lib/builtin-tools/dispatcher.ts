import type { AnalyseOp, WebSearchProxy } from "../api/builtin-tools";
import {
  formatAnalyseResult,
  formatDataResult,
  formatGrepResult,
  formatSearchFilesResult,
  formatWebFetchResult,
  formatWebSearchResult,
} from "./formatters";

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
  /** Corporate proxy config (Settings → Proxy). Forwarded into
   * `web_search` so outbound HTTP routes through it; the renderer reads
   * `useProxy()` and registers the snapshot here so the dispatcher
   * doesn't need to import a hook. `undefined` (or `enabled: false`)
   * means "no proxy". */
  proxyConfig?: WebSearchProxy;
}
const uiHandlers: BuiltinUiHandlers = {};

/** Read the currently-attached workspace folder, if any. Surfaced for the
 * composer's system-context injection so the model is told where it is. */
export function getBuiltinWorkspacePath(): string | undefined {
  const p = uiHandlers.workspacePath;
  return p && p.length > 0 ? p : undefined;
}

/** Register the React-side callbacks the dispatcher can invoke. Pass
 * `undefined` to clear a slot (e.g. on unmount). The composer wires this
 * up via `useEffect`. */
export function setBuiltinUiHandlers(next: BuiltinUiHandlers): void {
  Object.assign(uiHandlers, next);
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
          // Count the lines we actually got back. cat -n format prepends
          // a line-number column, so even an "empty" source line still
          // produces a non-empty rendered line; the only zero-length
          // entry from split is a trailing newline artefact.
          const off = typeof offset === "number" ? offset : 0;
          const linesShown = r.content
            ? r.content.split("\n").filter((l) => l.length > 0).length
            : 0;
          const endLine = off + linesShown;
          if (linesShown > 0 && endLine < r.totalLines) {
            headerLines.push(
              `Showing lines ${off + 1}-${endLine} of ${r.totalLines}. To read the next chunk, call again with offset=${endLine} (and optionally a larger limit).`,
            );
          } else {
            headerLines.push(`Total lines: ${r.totalLines}`);
          }
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
        const op = operation as AnalyseOp | undefined;
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
      case "web_search": {
        const { query, limit, region } = args as {
          query?: string;
          limit?: number;
          region?: string;
        };
        if (typeof query !== "string" || !query.trim()) {
          return { result: "web_search: missing `query`", isError: true };
        }
        // Snapshot proxy at call time so a Settings change applies on the
        // next search without restarting the agent loop. Only forward when
        // enabled — `undefined` lets the Rust side skip the proxy builder
        // entirely instead of constructing one with an empty host.
        const proxy = uiHandlers.proxyConfig;
        const r = await window.helixApi.webSearch({
          query: query.trim(),
          limit: typeof limit === "number" ? limit : undefined,
          region: typeof region === "string" ? region : undefined,
          proxy: proxy && proxy.enabled && proxy.host ? proxy : undefined,
        });
        return { result: formatWebSearchResult(r), isError: false };
      }
      case "web_fetch": {
        const { url, max_bytes } = args as {
          url?: string;
          max_bytes?: number;
        };
        if (typeof url !== "string" || !url.trim()) {
          return { result: "web_fetch: missing `url`", isError: true };
        }
        // Same proxy snapshot pattern as web_search — read at call time so
        // a Settings change applies to the next fetch without a restart.
        const proxy = uiHandlers.proxyConfig;
        const r = await window.helixApi.webFetch({
          url: url.trim(),
          maxBytes: typeof max_bytes === "number" ? max_bytes : undefined,
          proxy: proxy && proxy.enabled && proxy.host ? proxy : undefined,
        });
        return { result: formatWebFetchResult(r), isError: false };
      }
      case "dispatch_agent":
        // Sub-agent dispatch needs the parent's LLM client and tool set,
        // neither of which the (name, args)-only dispatcher has access to.
        // `useChat` intercepts the call inside its tool fan-out; reaching
        // this branch means the interceptor missed the call — surface an
        // error rather than silently returning success with nothing.
        return {
          result:
            "dispatch_agent must be intercepted by the parent agent loop and was not — this indicates an internal wiring bug.",
          isError: true,
        };
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
