import { invoke } from "@tauri-apps/api/core";
import type { AppView, DesktopAppState } from "../types";
import type { ThemeId } from "../themes";

export const helixApi = {
  ping: (): Promise<string> => invoke<string>("ping"),
  getState: (): Promise<DesktopAppState> => invoke<DesktopAppState>("get_state"),
  setTheme: (theme: ThemeId): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_theme", { theme }),
  setActiveView: (view: AppView): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_active_view", { view }),
};

export type HelixApi = typeof helixApi;
