import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "helix.composer.system-prompt";

function readStored(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStored(value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value.trim().length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, value);
    }
  } catch {
    /* localStorage full / disabled — keep the in-memory value so the
     * current session works even if persistence is broken. */
  }
}

export interface UseSystemPromptResult {
  readonly systemPrompt: string;
  readonly setSystemPrompt: (next: string) => void;
}

/** User-editable system prompt that rides along with every send as the
 * first system-context entry. Stored in localStorage globally — the same
 * prompt applies across sessions and workspaces. Empty / whitespace-only
 * values are dropped from the send payload so an empty editor reads as
 * "no override" rather than as a literal empty system message. */
export function useSystemPrompt(): UseSystemPromptResult {
  const [value, setValue] = useState<string>(() => readStored());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setValue(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setSystemPrompt = useCallback((next: string) => {
    setValue(next);
    writeStored(next);
  }, []);

  return { systemPrompt: value, setSystemPrompt };
}
