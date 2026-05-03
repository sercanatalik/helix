import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NoteWindow } from "./features/notes";
import { ThemeProvider } from "./hooks/use-theme";
import { helixApi } from "./lib/tauri-api";
import "./styles/index.css";

Object.defineProperty(window, "helixApi", {
  value: helixApi,
  writable: false,
  configurable: false,
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element missing from index.html");
}

// Single index.html serves multiple window types — branch on a URL param
// installed by the Rust side when it spawns a detached window.
const params = new URLSearchParams(window.location.search);
const windowKind = params.get("window");

const Root = windowKind === "note" ? NoteWindow : App;

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>,
);
