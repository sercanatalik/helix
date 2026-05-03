import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppView, DesktopAppState } from "../../app/types";
import type { ThemeId } from "../../themes";

export interface TreeEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "folder" | "file";
  readonly depth: number;
  /** File size in bytes; undefined for folders. */
  readonly size?: number;
}

const STATE_CHANGED_EVENT = "helix://state-changed";

export const coreApi = {
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
};
