import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "helix.mcp.disabled-tags";

/** Sentinel tag used for items the MCP server returns with no `tags`
 * array. Lets the user toggle the "untagged" bucket the same way they
 * toggle a real tag, without colliding with any plausible server-emitted
 * tag string. */
export const UNTAGGED_TAG = "__untagged";

function readStored(): readonly string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function writeStored(tags: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch {
    /* localStorage full / disabled — silently no-op so toggles still work
     * for the session even if they don't persist. */
  }
}

export interface UseMcpEnabledTagsResult {
  /** Read-side: the set of tags the user has explicitly DISABLED. Anything
   * not in the set — including tags the user has never seen — is enabled
   * by default (opt-out semantics). Stable identity across renders so
   * downstream `useMemo`s don't churn. */
  readonly disabledTags: ReadonlySet<string>;
  readonly isTagEnabled: (tag: string) => boolean;
  readonly toggleTag: (tag: string) => void;
  readonly setTagEnabled: (tag: string, enabled: boolean) => void;
}

/** Frontend-only store for "which MCP tags the user has switched off".
 * Persisted to `localStorage` rather than the Rust backend so we can ship
 * the tag-grouped palette without a schema migration on `McpServerConfig`.
 *
 * Defaults to opt-out: a tag is enabled until the user toggles it off, so
 * a fresh install gets the same "everything available" behavior the old
 * per-item popover had. The legacy `server.disabledTools` /
 * `server.enabledPrompts` fields are no longer consulted for model-side
 * tool binding — tag enablement is the only switch the user sees. */
export function useMcpEnabledTags(): UseMcpEnabledTagsResult {
  const [disabledList, setDisabledList] =
    useState<readonly string[]>(() => readStored());

  // Cross-tab sync: another window toggling a tag fires `storage`, so
  // every open palette stays in step. Listen for our own key only.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setDisabledList(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const disabledTags = useMemo(
    () => new Set(disabledList),
    [disabledList],
  );

  const isTagEnabled = useCallback(
    (tag: string) => !disabledTags.has(tag),
    [disabledTags],
  );

  const setTagEnabled = useCallback(
    (tag: string, enabled: boolean) => {
      setDisabledList((prev) => {
        const has = prev.includes(tag);
        if (enabled && !has) return prev;
        if (!enabled && has) return prev;
        const next = enabled
          ? prev.filter((t) => t !== tag)
          : [...prev, tag];
        writeStored(next);
        return next;
      });
    },
    [],
  );

  const toggleTag = useCallback(
    (tag: string) => {
      setDisabledList((prev) => {
        const has = prev.includes(tag);
        const next = has ? prev.filter((t) => t !== tag) : [...prev, tag];
        writeStored(next);
        return next;
      });
    },
    [],
  );

  return { disabledTags, isTagEnabled, toggleTag, setTagEnabled };
}
