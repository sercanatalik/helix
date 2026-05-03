/* helix-ai · built-in tools (barrel).
 *
 * The Rust backend exposes Read / Write / Edit / Glob / Grep as Tauri
 * commands; this module turns them into model-callable tools that ride the
 * same agent loop as MCP tools. The composer surfaces them in a popover and
 * `useChat` routes calls through the dispatcher when it sees the sentinel
 * server id.
 *
 * Tool names match the Tauri command names (`read_file` etc.) so the model
 * and the dispatcher agree on a single string. The user-facing label
 * (`Read`, `Write`, …) lives only in the popover.
 *
 * File layout:
 *   defs.ts        — JSON schemas, popover groups, slash command list
 *   dispatcher.ts  — runBuiltinTool, ui handler registry, workspace path resolve
 *   formatters.ts  — render Tauri results into model-friendly strings
 *   preferences.ts — useBuiltinTools hook + localStorage of disabled set
 */

export {
  BUILTIN_GROUP_LABEL,
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_TOOLS,
  isBuiltinTool,
  type BuiltinSlashCommand,
  type BuiltinToolDef,
  type BuiltinToolGroup,
} from "./defs";

export {
  BUILTIN_SERVER_ID,
  BUILTIN_SERVER_NAME,
  getBuiltinWorkspacePath,
  runBuiltinTool,
  setBuiltinUiHandlers,
} from "./dispatcher";

export {
  useBuiltinTools,
  type UseBuiltinToolsResult,
} from "./preferences";
