import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
