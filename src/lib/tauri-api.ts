import { invoke } from "@tauri-apps/api/core";
import type { AppView, DesktopAppState } from "../app/types";
import type { ThemeId } from "../themes";

export interface TreeEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "folder" | "file";
  readonly depth: number;
}

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
};

export type HelixApi = typeof helixApi;
