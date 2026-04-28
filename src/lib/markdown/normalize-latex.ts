// LLMs frequently emit LaTeX with \[…\] / \(…\) delimiters, but CommonMark
// treats `\[` and `\]` as escaped literal brackets, stripping the
// backslashes before remark-math (which only knows $…$ / $$…$$) ever runs.
// Rewrite those delimiters on the raw source — outside fenced or inline
// code, since users pasting examples shouldn't have their snippets mangled.

const FENCE_OR_INLINE_CODE = /(```[\s\S]*?```|`[^`\n]+`)/g;
const DISPLAY_MATH = /\\\[([\s\S]+?)\\\]/g;
const INLINE_MATH = /\\\(([\s\S]+?)\\\)/g;

export function normalizeLatexDelimiters(md: string): string {
  return md
    .split(FENCE_OR_INLINE_CODE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(DISPLAY_MATH, (_m, body) => `$$${body}$$`)
        .replace(INLINE_MATH, (_m, body) => `$${body}$`);
    })
    .join("");
}
