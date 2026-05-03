import { Kbd } from "../../../components/ui";
import type { Skill } from "../../../app/types";
import type { BuiltinSlashCommand } from "../../../lib/builtin-tools";

/** Union of items that can appear in the slash popover. Skills come
 * from disk and ride a separate render pipeline; built-in commands
 * fire side effects directly inside the composer. Discriminated
 * tag rather than two parallel arrays so ordering, highlighting, and
 * keyboard navigation stay simple. */
export type SlashItem =
  | { readonly kind: "skill"; readonly skill: Skill }
  | { readonly kind: "builtin"; readonly command: BuiltinSlashCommand };

export const EMPTY_SLASH_ITEMS: readonly SlashItem[] = [];

export interface SlashState {
  /** The portion after `/` and before the first space — what's being typed. */
  readonly query: string;
  /** Filtered candidates, in display order. Built-in commands first
   * (short, well-known list) so they're predictable to reach. */
  readonly candidates: readonly SlashItem[];
}

/** Detect whether the textarea contents start with a slash command and,
 * if so, filter the candidate list against the partial name. The menu
 * only appears while the user is still typing the name (no space yet)
 * — once they hit space they're in "arguments" territory and we hide
 * it. Built-in commands and skills share one filtered list. */
export function parseSlash(
  text: string,
  skills: readonly Skill[],
  commands: readonly BuiltinSlashCommand[],
): SlashState | null {
  if (!text.startsWith("/")) return null;
  // Hide once the user typed a space — they're entering arguments now.
  const sliced = text.slice(1);
  if (/\s/.test(sliced)) return null;
  const query = sliced.toLowerCase();
  // Prefix matches rank above substring matches so the auto-highlighted
  // top item is the natural completion of what the user just typed
  // (`/cle` → `/clear` at top, not some skill containing "cle" mid-name).
  // Stable sort preserves source order within each rank.
  const rank = (name: string) =>
    name.toLowerCase().startsWith(query) ? 0 : 1;
  const builtinCandidates = commands
    .filter((c) => c.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map<SlashItem>((command) => ({ kind: "builtin", command }));
  const skillCandidates = skills
    .filter((s) => !s.error && s.userInvocable)
    .filter((s) => s.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map<SlashItem>((skill) => ({ kind: "skill", skill }));
  return { query, candidates: [...builtinCandidates, ...skillCandidates] };
}

/** Match `/skill-name [args]` against the loaded skill list. Returns the
 * resolved skill plus the raw argument string (everything after the first
 * whitespace) when one matches; otherwise `null`. Names match case-
 * insensitively but Claude Code's spec restricts skill names to lowercase
 * anyway, so this is mostly defensive. */
function matchSlashInvocation(
  text: string,
  skills: readonly Skill[],
): { skill: Skill; args: string } | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  if (!name) return null;
  const args = space === -1 ? "" : body.slice(space + 1);
  const skill = skills.find(
    (s) => !s.error && s.userInvocable && s.name.toLowerCase() === name,
  );
  if (!skill) return null;
  return { skill, args };
}

/** Build the system messages helix prepends for skill awareness:
 *
 * - Always include a one-shot "available skills" listing so the model can
 *   auto-discover relevant skills mid-conversation (parity with how
 *   Claude Desktop pre-loads `name + description` for every skill).
 * - When the user typed `/skill-name args`, additionally include the
 *   rendered SKILL.md body as a system message so the model has the full
 *   instructions for this turn.
 *
 * The user's transcript text is left untouched — they see what they typed,
 * the model sees the skill body in addition. */
export async function buildSkillContext(
  userText: string,
  skills: readonly Skill[],
  render: (id: string, args: string) => Promise<string>,
  discoverable: readonly Skill[],
): Promise<string[]> {
  const out: string[] = [];

  if (discoverable.length > 0) {
    const lines = discoverable.map((s) => {
      const desc = s.description ?? "(no description)";
      const hint = s.argumentHint ? ` — usage: /${s.name} ${s.argumentHint}` : "";
      return `- /${s.name}: ${desc}${hint}`;
    });
    out.push(
      [
        "[helix skills · metadata]",
        "The user has these skills available. When a request matches one,",
        "follow the skill's instructions. The user can also invoke a skill",
        "directly with /skill-name args.",
        "",
        ...lines,
      ].join("\n"),
    );
  }

  const invocation = matchSlashInvocation(userText, skills);
  if (invocation) {
    try {
      const body = await render(invocation.skill.id, invocation.args);
      out.push(
        [
          `[helix skills · invoked: ${invocation.skill.name}]`,
          "The user explicitly invoked this skill. Follow its instructions",
          "verbatim for this turn.",
          "",
          body,
        ].join("\n"),
      );
    } catch (err) {
      out.push(
        `[helix skills · failed to render ${invocation.skill.name}]\n${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return out;
}

interface SkillsSlashMenuProps {
  readonly candidates: readonly SlashItem[];
  readonly highlight: number;
  readonly query: string;
  readonly onHover: (idx: number) => void;
  readonly onPick: (item: SlashItem) => void;
}

export function SkillsSlashMenu({
  candidates,
  highlight,
  query,
  onHover,
  onPick,
}: SkillsSlashMenuProps) {
  if (candidates.length === 0) {
    return (
      <div className="mcp-menu" role="listbox" aria-label="Slash commands">
        <header className="mcp-menu-head">
          <div>
            <div className="mcp-menu-title">Commands</div>
            <div className="mcp-menu-hint">
              Nothing matches <code>/{query}</code>. Add a skill under{" "}
              <code>~/.claude/skills/</code> or your workspace's{" "}
              <code>.claude/skills/</code>.
            </div>
          </div>
        </header>
      </div>
    );
  }
  return (
    <div className="mcp-menu" role="listbox" aria-label="Slash commands">
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            Commands
            <span className="mcp-menu-count">{candidates.length}</span>
          </div>
          <div className="mcp-menu-hint">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Tab</Kbd>/<Kbd>↵</Kbd>{" "}
            insert · <Kbd>Esc</Kbd> dismiss
          </div>
        </div>
      </header>
      <ul className="mcp-menu-items">
        {candidates.map((item, idx) => {
          const key =
            item.kind === "skill"
              ? `skill:${item.skill.id}`
              : `builtin:${item.command.name}`;
          const name =
            item.kind === "skill" ? item.skill.name : item.command.name;
          const description =
            item.kind === "skill"
              ? item.skill.description
              : item.command.description;
          const argumentHint =
            item.kind === "skill" ? item.skill.argumentHint : undefined;
          const sourceLabel =
            item.kind === "skill"
              ? item.skill.source === "project"
                ? "project"
                : "user"
              : "built-in";
          return (
            <li
              key={key}
              role="option"
              aria-selected={idx === highlight}
              className="mcp-menu-item mcp-menu-item-action"
              data-active={idx === highlight || undefined}
            >
              <button
                type="button"
                className="mcp-menu-item-body"
                onMouseEnter={() => onHover(idx)}
                onMouseDown={(e) => {
                  // mousedown so the click registers before the textarea
                  // blurs and the menu unmounts.
                  e.preventDefault();
                  onPick(item);
                }}
              >
                <span className="mcp-menu-item-text">
                  <code className="mcp-menu-item-name">/{name}</code>
                  {argumentHint ? (
                    <span className="mcp-menu-item-meta"> {argumentHint}</span>
                  ) : null}
                  {description ? (
                    <span className="mcp-menu-item-desc">{description}</span>
                  ) : null}
                  <span className="mcp-menu-item-meta">{sourceLabel}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
