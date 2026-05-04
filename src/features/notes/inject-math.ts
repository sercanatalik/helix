/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Markdown ↔ math bridge. BlockNote's parser doesn't know about LaTeX,
// so we run two passes: a markdown pre-process to fold multi-line `$$...$$`
// blocks down to a single line (BlockNote keeps each line as its own
// paragraph otherwise), and a post-parse walk to lift both `$...$` and
// `$$...$$` runs into our custom `inlineMath` / `mathBlock` schemas. The
// reverse runs on save so the on-disk markdown stays portable.

import { mapBlocks } from "../../lib/notes/walk-blocks";

// Match `$ ... $` runs that don't span newlines, allow escaped `\$` inside.
// Anchored on word/space/punctuation boundaries so prices like "$5" don't
// accidentally trigger.
const INLINE_MATH = /(?<![\\$])\$([^\n$]+?)\$(?!\d)/g;

// Match `$$ ... $$` runs anchored on their own paragraph. Multi-line allowed
// in source — we collapse to single-line during pre-process so BlockNote's
// parser puts the result into one paragraph node.
const DISPLAY_MATH_MULTILINE = /\$\$([\s\S]+?)\$\$/g;
// Match a paragraph whose entire text is `$$LATEX$$` (no surrounding text).
const DISPLAY_MATH_PARA = /^\s*\$\$([^$]+)\$\$\s*$/;

interface MathSplit {
  readonly kind: "text" | "math";
  readonly value: string;
}

function splitMath(text: string): readonly MathSplit[] {
  const out: MathSplit[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_MATH)) {
    const idx = match.index ?? 0;
    const latex = match[1] ?? "";
    if (idx > lastIndex) {
      out.push({ kind: "text", value: text.slice(lastIndex, idx) });
    }
    out.push({ kind: "math", value: latex });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex === 0) {
    return [{ kind: "text", value: text }];
  }
  if (lastIndex < text.length) {
    out.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return out;
}

function injectInline(content: any[]): any[] {
  const out: any[] = [];
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") {
      const parts = splitMath(item.text);
      const onlyText = parts.length === 1 && parts[0]?.kind === "text";
      if (onlyText) {
        out.push(item);
        continue;
      }
      for (const part of parts) {
        if (part.kind === "math") {
          out.push({
            type: "inlineMath",
            props: { latex: part.value },
            // Custom inline content with `content: "none"` carries no
            // child content; BlockNote still expects the field to exist.
          });
        } else if (part.value.length > 0) {
          out.push({ ...item, text: part.value });
        }
      }
    } else if (item && item.type === "link" && Array.isArray(item.content)) {
      out.push({ ...item, content: injectInline(item.content) });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** Walk parsed blocks and lift `$...$` runs out of text content into
 * `inlineMath` nodes. Mutates a fresh copy — the input is not modified. */
export function injectMathIntoBlocks(blocks: any[]): any[] {
  return mapBlocks(blocks, (block) =>
    Array.isArray(block?.content)
      ? { ...block, content: injectInline(block.content) }
      : block,
  );
}

function extractInline(content: any[]): any[] {
  const out: any[] = [];
  for (const item of content) {
    if (item && item.type === "inlineMath") {
      const latex = item.props?.latex ?? "";
      out.push({ type: "text", text: `$${latex}$`, styles: {} });
    } else if (item && item.type === "link" && Array.isArray(item.content)) {
      out.push({ ...item, content: extractInline(item.content) });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** Walk blocks pre-serialization and flatten `inlineMath` nodes back into
 * `$...$` plain text so `blocksToMarkdownLossy` produces portable markdown.
 * Also flattens `mathBlock` blocks into `$$...$$` paragraph blocks. */
export function extractMathToText(blocks: any[]): any[] {
  return mapBlocks(blocks, (block) => {
    if (block?.type === "mathBlock") {
      const latex = block.props?.latex ?? "";
      return {
        type: "paragraph",
        content: [{ type: "text", text: `$$${latex}$$`, styles: {} }],
      };
    }
    if (Array.isArray(block?.content)) {
      return { ...block, content: extractInline(block.content) };
    }
    return block;
  });
}

/** Pre-process raw markdown so multi-line `$$ ... $$` runs collapse to a
 * single line. BlockNote's parser otherwise turns a fenced display-math
 * block into one paragraph per source line, which our post-parse walker
 * can't recognise. Single-line `$$x$$` in the source is left alone. */
export function preProcessDisplayMath(markdown: string): string {
  return markdown.replace(DISPLAY_MATH_MULTILINE, (full, latex: string) => {
    const collapsed = latex.replace(/\s*\n\s*/g, " ").trim();
    return `$$${collapsed}$$`;
  });
}

/** Walk parsed blocks and lift paragraphs whose only content is `$$X$$`
 * into `mathBlock` blocks. Run AFTER `injectMathIntoBlocks` so inline
 * math nodes don't get re-considered. */
export function injectMathBlocks(blocks: any[]): any[] {
  return mapBlocks(blocks, (block) => {
    if (
      block?.type === "paragraph" &&
      Array.isArray(block.content) &&
      block.content.length === 1 &&
      block.content[0]?.type === "text" &&
      typeof block.content[0]?.text === "string"
    ) {
      const match = block.content[0].text.match(DISPLAY_MATH_PARA);
      if (match) {
        return { type: "mathBlock", props: { latex: match[1].trim() } };
      }
    }
    return block;
  });
}
