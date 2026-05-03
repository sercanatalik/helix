import type {
  AnalyseResult,
  DataColumnInfo,
  DataPreviewRow,
  GrepResult,
  ReadExcelResult,
  SearchFilesResult,
  WebFetchResponse,
  WebSearchResponse,
} from "../api/builtin-tools";

// Result formatters for tool output. The dispatcher hands the model a
// single string; these turn the structured Tauri responses into
// human-readable bodies that the agent loop can reason about.

export function formatDataResult(r: ReadExcelResult): string {
  const head = `Loaded ${r.path}\nsheet: ${r.sheet} (of ${r.sheetNames.length}: ${r.sheetNames.join(", ")})\nshape: ${r.shape[0]} rows × ${r.shape[1]} columns\nhandle: ${r.handle}`;
  return `${head}\n\nColumns:\n${formatColumns(r.columns)}\n\nPreview (first ${r.preview.length}):\n${formatPreviewRows(r.columns, r.preview)}`;
}

export function formatAnalyseResult(r: AnalyseResult): string {
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

function formatColumns(columns: readonly DataColumnInfo[]): string {
  return columns.map((c) => `  ${c.name}: ${c.dtype}`).join("\n");
}

function formatPreviewRows(
  columns: readonly DataColumnInfo[],
  rows: readonly DataPreviewRow[],
): string {
  if (rows.length === 0) return "(empty)";
  const header = columns.map((c) => c.name).join("\t");
  const body = rows
    .map((row) => columns.map((c) => formatCell(row[c.name])).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function formatSearchFilesResult(r: SearchFilesResult): string {
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

export function formatGrepResult(r: GrepResult): string {
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

/** Render web search hits as a numbered list the model can quote and link
 * to. Snippets are kept verbatim — DDG strips most highlight markup before
 * we even see them, and an unfiltered passthrough is faster than guessing
 * what the model wants summarized. */
export function formatWebSearchResult(r: WebSearchResponse): string {
  const head = `Search: ${r.query}`;
  if (r.hits.length === 0) {
    const reason = r.parseWarning ?? "No results.";
    return `${head}\n\n${reason}`;
  }
  const body = r.hits
    .map((h, i) => {
      const snippet = h.snippet ? `\n   ${h.snippet}` : "";
      return `${i + 1}. ${h.title}\n   ${h.url}${snippet}`;
    })
    .join("\n\n");
  const warn = r.parseWarning ? `\n\n[note] ${r.parseWarning}` : "";
  return `${head}\n\n${body}${warn}`;
}

/** Render a fetched page as a header block followed by the extracted body.
 * The header carries the metadata the model needs to cite (final URL after
 * redirects, status, content type) and a truncation flag so the agent can
 * decide whether to re-fetch with a larger `max_bytes`. Non-2xx statuses
 * get a `[non-2xx response]` banner so the model treats the body as an
 * error page (consent wall, anti-bot screen, "moved", etc.) rather than
 * the canonical content. */
export function formatWebFetchResult(r: WebFetchResponse): string {
  const redirected = r.finalUrl && r.finalUrl !== r.url;
  const isError = r.status < 200 || r.status >= 300;
  const headLines = [
    isError
      ? `[non-2xx response — body below is what the server returned, likely an error page or consent wall]`
      : null,
    `URL: ${r.url}`,
    redirected ? `Final URL: ${r.finalUrl}` : null,
    `HTTP ${r.status} · ${r.contentType || "unknown content-type"} · ${r.byteCount} bytes${r.truncated ? " · truncated" : ""}`,
  ].filter(Boolean);
  const head = headLines.join("\n");
  if (!r.text) {
    return `${head}\n\n(empty body)`;
  }
  const tail = r.truncated
    ? `\n\n[truncated at ${r.byteCount} bytes — call again with a larger max_bytes to see more]`
    : "";
  return `${head}\n\n${r.text}${tail}`;
}
