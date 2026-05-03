// Models frequently emit code with a "LANG:" prefix instead of a fenced
// markdown block — e.g. `SQL: SELECT * FROM ...`. CommonMark renders that as
// inline prose, defeating syntax highlighting. Detect the pattern on the raw
// source and rewrite it into a real fenced block so the existing Shiki path
// picks it up.
//
// Conservative heuristic: only fire when the first token after the prefix is
// a recognised keyword for that language. That avoids wrapping casual prose
// like "SQL: it's faster than Mongo for this".

const FENCE_OR_INLINE_CODE = /(```[\s\S]*?```|`[^`\n]+`)/g;

interface LanguageRule {
  /** Fence info-string used after `\`\`\``. */
  readonly lang: string;
  /** Aliases the model might use as the prefix label (case-insensitive). */
  readonly aliases: readonly string[];
  /** Keywords expected as the first token of the body. Uppercase. */
  readonly keywords: ReadonlySet<string>;
}

const RULES: readonly LanguageRule[] = [
  {
    lang: "sql",
    aliases: ["sql"],
    keywords: new Set([
      "SELECT",
      "WITH",
      "INSERT",
      "UPDATE",
      "DELETE",
      "CREATE",
      "ALTER",
      "DROP",
      "EXPLAIN",
      "MERGE",
      "USE",
      "SHOW",
      "DESCRIBE",
      "DESC",
      "TRUNCATE",
      "GRANT",
      "REVOKE",
      "CALL",
      "PRAGMA",
    ]),
  },
];

const ALIAS_PATTERN = RULES.flatMap((r) => r.aliases).join("|");
// Match `(start-of-line)(LABEL):(body)` up to the next blank line or EOF.
// Multiline + case-insensitive; non-greedy so multiple snippets in one buffer
// don't get glued together.
const PREFIX_RE = new RegExp(
  String.raw`^[ \t]*(${ALIAS_PATTERN}):[ \t]*([\s\S]*?)(?=\n\s*\n|$)`,
  "gim",
);

export function normalizeCodePrefixes(md: string): string {
  // Honour fenced/inline code by splitting on it and only operating on the
  // prose segments — same approach as normalizeLatexDelimiters.
  return md
    .split(FENCE_OR_INLINE_CODE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(PREFIX_RE, (match, label: string, body: string) => {
        const trimmed = body.trim();
        if (!trimmed) return match;
        const firstWord = trimmed.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
        if (!firstWord) return match;
        const rule = RULES.find((r) =>
          r.aliases.some((a) => a.toLowerCase() === label.toLowerCase()),
        );
        if (!rule || !rule.keywords.has(firstWord)) return match;
        // Surround with blank lines so the fence isn't glued to neighbouring
        // paragraphs (CommonMark requires a blank line before/after).
        return `\n\n\`\`\`${rule.lang}\n${trimmed}\n\`\`\`\n`;
      });
    })
    .join("");
}
