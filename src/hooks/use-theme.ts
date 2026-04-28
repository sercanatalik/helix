import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_THEME, isThemeId, type ThemeId } from "../themes";

const STORAGE_KEY = "helix.theme";

function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isThemeId(raw) ? raw : DEFAULT_THEME;
}

interface ThemeContextValue {
  readonly theme: ThemeId;
  readonly setTheme: (theme: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  // Apply on mount + whenever theme changes; the [data-theme] attribute is
  // what every CSS module keys off of.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Reconcile with the Rust-held state once the backend wakes up. The local
  // value already painted, so this is a no-op in the common case.
  useEffect(() => {
    let cancelled = false;
    void window.helixApi
      .getState()
      .then((state) => {
        if (cancelled) return;
        if (isThemeId(state.theme) && state.theme !== theme) {
          setThemeState(state.theme);
        } else {
          // Push the locally-cached theme up so backend matches.
          void window.helixApi.setTheme(theme);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Run once on mount; subsequent updates flow through `setTheme`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    void window.helixApi.setTheme(next).catch(() => undefined);
  }, []);

  return createElement(
    ThemeContext.Provider,
    { value: { theme, setTheme } },
    children,
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return ctx;
}
