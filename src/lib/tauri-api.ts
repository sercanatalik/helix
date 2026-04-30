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
};

export type HelixApi = typeof helixApi;

// Re-export the McpServerConfig type for callers that import the API module
// — saves a second import of `../app/types` for UI components that operate
// on a server record returned by these methods.
export type { McpServerConfig };
