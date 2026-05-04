/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Markdown ↔ Vega bridge for the BlockNote rich editor.
//
// On parse: walk the parsed blocks, find any `codeBlock` whose language is
// `vega-lite | vegalite | vega` (or `json` containing what looks like a
// Vega-Lite spec), and replace it with our custom `vegaBlock` so the chart
// renders inline instead of showing the raw spec.
//
// On serialize: reverse the mapping — `vegaBlock` blocks become fenced
// code blocks again so the on-disk markdown stays portable and editable in
// any other tool.

import { mapBlocks } from "../../lib/notes/walk-blocks";

const VEGA_LANGS = new Set(["vega-lite", "vegalite", "vega"]);

function detectVegaLanguage(language: unknown, code: unknown): string | null {
  const lang = typeof language === "string" ? language.toLowerCase() : "";
  if (VEGA_LANGS.has(lang)) {
    return lang === "vegalite" ? "vega-lite" : lang;
  }
  // The model often emits Vega-Lite specs inside ```json (or no language at
  // all). Fall back to content-shape detection for any code block whose
  // body parses as JSON — conservative guard via the schema/shape check
  // below means random JSON stays a code block.
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const schema = o.$schema;
  if (typeof schema === "string" && /vega/i.test(schema)) {
    return /vega-lite/i.test(schema) ? "vega-lite" : "vega";
  }
  if ("marks" in o && "scales" in o) return "vega";
  if (
    ("mark" in o ||
      "layer" in o ||
      "hconcat" in o ||
      "vconcat" in o ||
      "concat" in o) &&
    "encoding" in o
  ) {
    return "vega-lite";
  }
  return null;
}

/** BlockNote 0.46 stores a code block roughly as
 * `{ type: "codeBlock", props: { language }, content: [{ type: "text", text }] }`,
 * but parsed blocks coming back from `tryParseMarkdownToBlocks` sometimes
 * surface the body as a plain string on `content` instead of an array of
 * inline nodes. Handle both shapes. */
function codeBlockText(block: any): string {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }
  // Some specs store the source on a prop (e.g. when the code block uses
  // `content: "none"`). Try the obvious names.
  const props = block?.props;
  if (props && typeof props === "object") {
    if (typeof props.code === "string") return props.code;
    if (typeof props.text === "string") return props.text;
  }
  return "";
}

/** Walk parsed blocks; convert any code block whose language identifies
 * a Vega/Vega-Lite spec into a `vegaBlock`. Mutates a fresh copy. */
export function injectVegaBlocks(blocks: any[]): any[] {
  return mapBlocks(blocks, (block) => {
    if (block?.type === "codeBlock") {
      const code = codeBlockText(block);
      const detected = detectVegaLanguage(block.props?.language, code);
      if (detected) {
        return {
          type: "vegaBlock",
          props: { spec: code, language: detected },
        };
      }
    }
    return block;
  });
}

/** Reverse of `injectVegaBlocks`: emit a fenced code block in the original
 * language so `blocksToMarkdownLossy` produces portable markdown. Run
 * before any other extraction step that walks the block tree. */
export function extractVegaToCodeBlocks(blocks: any[]): any[] {
  return mapBlocks(blocks, (block) => {
    if (block?.type === "vegaBlock") {
      return {
        type: "codeBlock",
        props: { language: block.props?.language ?? "vega-lite" },
        content: [
          { type: "text", text: block.props?.spec ?? "", styles: {} },
        ],
      };
    }
    return block;
  });
}
