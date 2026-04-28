import type { HelixApi } from "./lib/tauri-api";

declare global {
  interface Window {
    readonly helixApi: HelixApi;
  }
}

export {};
