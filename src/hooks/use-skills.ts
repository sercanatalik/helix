import { useCallback, useEffect, useState } from "react";
import type { DesktopAppState, Skill } from "../app/types";

const EMPTY_SKILLS: readonly Skill[] = [];

export interface UseSkillsResult {
  readonly skills: readonly Skill[];
  /** Force a manual rescan. The list arrives via `helix://state-changed`,
   * but this is useful right after the user creates their first
   * `.claude/skills/` directory (the watcher only fires on existing dirs). */
  readonly reload: () => Promise<void>;
  /** Render a skill body with argument substitution. Returns the string the
   * caller should send as a hidden system message before the user's text. */
  readonly render: (skillId: string, args: string) => Promise<string>;
}

/** Read-only view over the skills list owned by the Rust backend. Mirrors
 * the pattern in `use-mcp-servers` — seed once, then track the
 * `helix://state-changed` push channel for live updates. The Rust side is
 * the source of truth; the hook never holds an optimistic copy. */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<readonly Skill[]>(EMPTY_SKILLS);

  useEffect(() => {
    let cancelled = false;
    void window.helixApi
      .getState()
      .then((state) => {
        if (cancelled) return;
        setSkills(state.skills);
      })
      .catch(() => {
        // Backend not ready yet — keep the empty default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const apply = (state: DesktopAppState) => {
      setSkills(state.skills);
    };
    return window.helixApi.onStateChanged(apply);
  }, []);

  const reload = useCallback(async () => {
    const state = await window.helixApi.reloadSkills();
    setSkills(state.skills);
  }, []);

  const render = useCallback(
    (skillId: string, args: string): Promise<string> =>
      window.helixApi.renderSkill(skillId, args),
    [],
  );

  return { skills, reload, render };
}
