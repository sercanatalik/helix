/** A prompt, resource, or workspace file the user has loaded into context
 * for the next message. Stored entirely on the frontend — sent to the model
 * as a system message via `ChatExtras.systemContext`, never written to the
 * transcript. The `file` kind is produced by clicking a file in the
 * workspace panel; its content rides through `read_file` so the header in
 * `contextHeader` names that tool. */
export interface PendingContextEntry {
  readonly id: string;
  readonly kind: "prompt" | "resource" | "file";
  readonly serverName: string;
  readonly label: string;
  readonly content: string;
}

/** Wrap the content sent to the model with a tiny attribution header, so a
 * model that's seeing many MCP-derived system messages can tell where each
 * came from. Visible only inside the API call, never the transcript.
 *
 * The `file` variant is used when the user clicks a file in the workspace
 * panel — `serverName` is set to `"read_file"` so the model can correlate
 * the inline content with that built-in tool. */
export function contextHeader(
  kind: "prompt" | "resource" | "file",
  serverName: string,
  label: string,
): string {
  if (kind === "file") {
    return `[helix workspace file · loaded via read_file · ${label}]\n`;
  }
  return `[helix mcp ${kind} · ${serverName} · ${label}]\n`;
}

/** When the active workspace has an attached folder, tell the model about
 * it so file-writing tools land in the right place. Returns an empty list
 * (caller spreads it) when no folder is attached, leaving extras unchanged. */
export function buildWorkspaceContext(path: string | undefined): string[] {
  if (!path) return [];
  return [
    [
      "[helix workspace]",
      `The user's active workspace folder is: ${path}`,
      "When you call file-system tools (read_file, write_file, edit_file,",
      "glob_files, grep_search, search_files, read_pdf, read_excel), use",
      "this folder as the working directory. Relative paths in tool",
      "arguments are resolved against it; search tools that take a root",
      "default to it. Prefer relative paths so files land inside the user's",
      "workspace unless the user explicitly asks for a different location.",
    ].join("\n"),
  ];
}

import { UNTAGGED_TAG } from "../../../hooks/use-mcp-enabled-tags";

/** True when at least one of the item's tags is currently enabled.
 * Untagged items defer to the `__untagged` sentinel so the user can still
 * silence them as a bucket. Mirrors the rule the palette renders against
 * (`enabled if any tag is on`) so chip counts and the model binding agree. */
export function itemEnabledByTags(
  tags: readonly string[] | undefined,
  isTagEnabled: (tag: string) => boolean,
): boolean {
  if (!tags || tags.length === 0) return isTagEnabled(UNTAGGED_TAG);
  for (const tag of tags) if (isTagEnabled(tag)) return true;
  return false;
}
