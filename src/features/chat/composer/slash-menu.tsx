import { Kbd } from "../../../components/ui";
import type { Skill } from "../../../app/types";
import type { BuiltinSlashCommand } from "../../../lib/builtin-tools";
import type { PendingContextEntry } from "./pending-context";

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
  /** Character range of the active token (the `/` and what follows it
   * up to the caret-side word boundary). Used by the composer to splice
   * a picked item into the existing text instead of replacing all of it. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
  /** True when the active token is the very first thing in the textarea.
   * Built-in commands (`/clear`, `/write-to-workspace`) only mean anything
   * as the entire message, so the menu hides them when the user is mid-
   * message. */
  readonly atStart: boolean;
}

/** Locate the slash-token under the caret, if any. A "slash token" is
 * `/` at the very start of the text or immediately after whitespace,
 * followed by zero or more non-whitespace characters. The caret must
 * sit inside that token (between the `/` and the next whitespace) for
 * the menu to be considered active — once the user types past it, the
 * token is finalized and the menu closes. */
function findActiveSlashToken(
  text: string,
  caret: number,
): { start: number; end: number } | null {
  // Walk backwards from the caret to find the nearest `/` that opens a
  // token (preceded by start-of-text or whitespace, and with no
  // intervening whitespace between it and the caret).
  let start = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i] ?? "";
    if (/\s/.test(ch)) return null;
    if (ch === "/") {
      const prev = i === 0 ? "" : text[i - 1] ?? "";
      if (i === 0 || /\s/.test(prev)) {
        start = i;
        break;
      }
      // A `/` that isn't at a word boundary (e.g. inside a URL) doesn't
      // open a token.
      return null;
    }
  }
  if (start === -1) return null;
  // Extend forward from the caret to the next whitespace to capture the
  // full token range — needed so we know what to splice when the user
  // picks a candidate.
  let end = caret;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end++;
  return { start, end };
}

/** Detect whether the active slash-token under the caret should pop the
 * menu, and if so, build the candidate list. Skills can be invoked
 * anywhere in the message (mid-sentence is fine — multiple in one
 * message is fine), but built-in commands (`/clear`, etc.) are only
 * surfaced when the token is at position 0 since they take over the
 * whole message. */
export function parseSlash(
  text: string,
  caret: number,
  skills: readonly Skill[],
  commands: readonly BuiltinSlashCommand[],
): SlashState | null {
  const token = findActiveSlashToken(text, caret);
  if (!token) return null;
  const partial = text.slice(token.start + 1, token.end);
  const query = partial.toLowerCase();
  const atStart = token.start === 0;
  // Prefix matches rank above substring matches so the auto-highlighted
  // top item is the natural completion of what the user just typed
  // (`/cle` → `/clear` at top, not some skill containing "cle" mid-name).
  // Stable sort preserves source order within each rank.
  const rank = (name: string) =>
    name.toLowerCase().startsWith(query) ? 0 : 1;
  const builtinCandidates = atStart
    ? commands
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice()
        .sort((a, b) => rank(a.name) - rank(b.name))
        .map<SlashItem>((command) => ({ kind: "builtin", command }))
    : [];
  const skillCandidates = skills
    .filter((s) => !s.error && s.userInvocable)
    .filter((s) => s.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map<SlashItem>((skill) => ({ kind: "skill", skill }));
  return {
    query,
    candidates: [...builtinCandidates, ...skillCandidates],
    tokenStart: token.start,
    tokenEnd: token.end,
    atStart,
  };
}

export interface SkillMention {
  readonly skill: Skill;
  readonly args: string;
  readonly start: number;
  readonly end: number;
}

/** Find every `/skill-name` mention in the text that resolves to a real
 * skill. Mentions are at word boundaries (start-of-text or after
 * whitespace). The single-mention-at-start case grabs everything after
 * the skill name as `args` for backward compatibility with the original
 * `/skill arg1 arg2` UX; mid-message mentions get empty args because
 * there's no clean delimiter when more skills could follow. */
export function findSkillMentions(
  text: string,
  skills: readonly Skill[],
): readonly SkillMention[] {
  const skillByName = new Map<string, Skill>();
  for (const s of skills) {
    if (s.error || !s.userInvocable) continue;
    skillByName.set(s.name.toLowerCase(), s);
  }
  if (skillByName.size === 0) return [];

  const mentions: SkillMention[] = [];
  // /name where name is non-empty and only contains [\w-] (Claude Code
  // restricts skill names to lowercase letters / digits / hyphens).
  const re = /(^|\s)\/([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const rawName = match[2] ?? "";
    const skill = skillByName.get(rawName.toLowerCase());
    if (!skill) continue;
    const start = match.index + lead.length;
    const end = start + 1 + rawName.length;
    mentions.push({ skill, args: "", start, end });
  }

  // Backward-compat: when the user typed exactly one mention, at the
  // start of the message, with text after it, treat the trailing text as
  // `$ARGUMENTS` for the skill body. Multi-mention messages skip this —
  // there's no unambiguous way to assign args.
  const only = mentions[0];
  if (mentions.length === 1 && only && only.start === 0) {
    const tail = text.slice(only.end);
    const argsMatch = tail.match(/^\s+([\s\S]+)$/);
    if (argsMatch && argsMatch[1]) {
      return [{ ...only, args: argsMatch[1] }];
    }
  }
  return mentions;
}

/** Build the system messages helix prepends for skill awareness:
 *
 * - Always include a one-shot "available skills" listing so the model can
 *   auto-discover relevant skills mid-conversation (parity with how
 *   Claude Desktop pre-loads `name + description` for every skill).
 * - For each `/skill-name` mention in the user's text, additionally
 *   include the rendered SKILL.md body as a system message so the model
 *   has the full instructions for this turn.
 *
 * The user's transcript text is left untouched — they see what they typed,
 * the model sees the skill body in addition. */
export async function buildSkillContext(
  userText: string,
  skills: readonly Skill[],
  render: (id: string, args: string) => Promise<string>,
  discoverable: readonly Skill[],
  pendingContext: readonly PendingContextEntry[] = [],
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

  const mentions = findSkillMentions(userText, skills);
  // De-dupe by skill id — if the user types the same skill twice in one
  // message, the body still only needs to ride along once.
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (seen.has(mention.skill.id)) continue;
    seen.add(mention.skill.id);
    try {
      const body = await render(mention.skill.id, mention.args);
      // List pending workspace files so the model treats them as the
      // skill's source material instead of unrelated background context.
      // Without this hint a slash invocation reads as bare metadata —
      // the model has no signal that "the user attached foo.md and
      // wants this skill applied to it".
      const attachedFiles = pendingContext.filter((p) => p.kind === "file");
      const attachmentLines =
        attachedFiles.length > 0
          ? [
              "",
              "Attached workspace files (already loaded into context above):",
              ...attachedFiles.map((f) => `- ${f.label}`),
              "Treat these as the source material for this skill where",
              "applicable. Do not ask the user to provide content that's",
              "already attached.",
            ]
          : [];
      out.push(
        [
          `[helix skills · invoked: ${mention.skill.name}]`,
          "The user explicitly invoked this skill. Follow its instructions",
          "verbatim for this turn.",
          ...attachmentLines,
          "",
          body,
        ].join("\n"),
      );
    } catch (err) {
      out.push(
        `[helix skills · failed to render ${mention.skill.name}]\n${
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
                : item.skill.source === "builtin"
                  ? "built-in"
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
