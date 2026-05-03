import { useCallback, useEffect, useState } from "react";
import { BUILTIN_TOOLS, type BuiltinToolDef } from "./defs";

const STORAGE_KEY = "helix.builtin-tools.disabled";

function readDisabled(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeDisabled(names: readonly string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // Quota / privacy mode — surface failures via the UI? For now the
    // toggle just doesn't persist. Better than crashing the composer.
  }
}

export interface UseBuiltinToolsResult {
  /** The full catalogue (always returns every tool). */
  readonly tools: readonly BuiltinToolDef[];
  /** True when the named tool should be advertised to the model. */
  readonly isEnabled: (name: string) => boolean;
  /** Names currently enabled — derived, sorted in catalogue order. */
  readonly enabledNames: readonly string[];
  readonly setEnabled: (name: string, enabled: boolean) => void;
  /** Bulk toggle. Shortcut for the "all on / all off" switch. */
  readonly setAllEnabled: (enabled: boolean) => void;
}

/** All built-in tools default to *enabled*. Storage persists the disabled
 * set rather than the enabled set so a future addition to the catalogue
 * automatically opts the user in (parity with the MCP `disabledTools`
 * pattern in the backend). */
export function useBuiltinTools(): UseBuiltinToolsResult {
  const [disabled, setDisabled] = useState<readonly string[]>(() =>
    readDisabled(),
  );

  useEffect(() => {
    writeDisabled(disabled);
  }, [disabled]);

  const isEnabled = useCallback(
    (name: string) => !disabled.includes(name),
    [disabled],
  );

  const setEnabled = useCallback((name: string, enabled: boolean) => {
    setDisabled((curr) => {
      if (enabled) {
        if (!curr.includes(name)) return curr;
        return curr.filter((n) => n !== name);
      }
      if (curr.includes(name)) return curr;
      return [...curr, name];
    });
  }, []);

  const setAllEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      setDisabled([]);
    } else {
      setDisabled(BUILTIN_TOOLS.map((t) => t.name));
    }
  }, []);

  const enabledNames = BUILTIN_TOOLS.map((t) => t.name).filter(
    (n) => !disabled.includes(n),
  );

  return {
    tools: BUILTIN_TOOLS,
    isEnabled,
    enabledNames,
    setEnabled,
    setAllEnabled,
  };
}
