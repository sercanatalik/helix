import { invoke } from "@tauri-apps/api/core";
import type { DesktopAppState } from "../../app/types";

// Claude Desktop / Claude Code parity: the backend watches
// `~/.claude/skills` and `<workspace>/.claude/skills`, parses each
// `SKILL.md`, and emits the merged list via `helix://state-changed`. The
// commands below let the frontend retarget the project root, force a
// rescan, and render a skill body for invocation.

export const skillsApi = {
  /** Update the workspace whose `.claude/skills` directory should be
   * watched. Pass `undefined` (or an empty string) when no workspace is
   * active. Returns the post-update snapshot synchronously; subsequent
   * filesystem changes arrive on `helix://state-changed`. */
  setSkillsWorkspace: (
    workspace: string | undefined,
  ): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("set_skills_workspace", { workspace }),

  /** Force a manual rescan of every skills root. Useful when the user has
   * just created `.claude/skills/` for the first time — the watcher needs
   * an existing directory to fire on. */
  reloadSkills: (): Promise<DesktopAppState> =>
    invoke<DesktopAppState>("reload_skills"),

  /** Render a skill into the string the chat view should send as a hidden
   * system message. Substitutes `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, and
   * named placeholders (declared in the frontmatter `arguments` list)
   * following Claude Code's rules. */
  renderSkill: (skillId: string, args: string): Promise<string> =>
    invoke<string>("render_skill", { skillId, arguments: args }),
};
