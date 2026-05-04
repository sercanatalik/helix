import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // The chunks crossing the default 500KB warning threshold are all
    // already-lazy vendor bundles that can't be split further by us:
    // BlockNote (rich note editor) drags in shiki + mantine + prosemirror
    // and only loads when a note is opened in rich mode; shiki language
    // grammars (cpp, emacs-lisp, ...) load only when their language
    // appears in a code block; vega's runtime + wasm load only when a
    // chart is rendered. Set above the largest legitimate-lazy chunk
    // (~1.05MB BlockNote) so a regression on an eager bundle still fires.
    chunkSizeWarningLimit: 1100,
  },
});
