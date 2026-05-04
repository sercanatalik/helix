import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
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
// installed by the Rust side when it spawns a detached window. Both roots
// are lazy-loaded so whichever isn't picked stays out of the initial chunk
// (NoteWindow alone pulls in BlockNote + CodeMirror + shiki).
const params = new URLSearchParams(window.location.search);
const windowKind = params.get("window");

const Root =
  windowKind === "note"
    ? lazy(() =>
        import("./features/notes").then((m) => ({ default: m.NoteWindow })),
      )
    : lazy(() => import("./App").then((m) => ({ default: m.App })));

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </ThemeProvider>
  </StrictMode>,
);
