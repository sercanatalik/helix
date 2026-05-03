import { useEffect, useMemo, useRef } from "react";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { codeBlockOptions } from "@blocknote/code-block";
import { inlineMathSpec } from "./inline-math";
import { mathBlockSpec } from "./math-block";
import {
  extractMathToText,
  injectMathBlocks,
  injectMathIntoBlocks,
  preProcessDisplayMath,
} from "./inject-math";
import { useTheme } from "../../hooks/use-theme";
import type { ThemeId } from "../../themes";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";

/** Map a helix theme id to the dark/light flavour BlockNote's mantine
 * variant understands. Two of our four themes are dark; the rest light. */
function blocknoteFlavourFor(theme: ThemeId): "dark" | "light" {
  return theme === "dark" || theme === "meridian-dark" ? "dark" : "light";
}

interface BlockNoteEditorProps {
  readonly initialMarkdown: string;
  /** Fires on every document change with the latest markdown. The parent
   * debounces saves on top so we don't hammer the disk per keystroke. */
  readonly onChange: (markdown: string) => void;
}

/** Wraps BlockNote with our preferred defaults. The parent component
 * remounts this via `key={noteId}` when switching notes so the editor
 * always starts from a clean state with the right initial content.
 *
 * BlockNote 0.46 ships code-block support out of the box; we replace the
 * default code-block spec with `@blocknote/code-block`'s shiki-backed
 * variant so we get real syntax highlighting across the bundled languages
 * (TypeScript, Rust, Python, Go, …) instead of plain monospaced text. */
export function BlockNoteEditor({
  initialMarkdown,
  onChange,
}: BlockNoteEditorProps) {
  const { theme } = useTheme();
  const blockNoteTheme = blocknoteFlavourFor(theme);
  // Build the schema once per mount. `useMemo` matters here: re-creating
  // the schema on every render would also re-create the editor below
  // (since `useCreateBlockNote` depends on it) and wipe the document.
  const schema = useMemo(
    () =>
      BlockNoteSchema.create({
        blockSpecs: {
          ...defaultBlockSpecs,
          codeBlock: createCodeBlockSpec(codeBlockOptions),
          mathBlock: mathBlockSpec,
        },
        inlineContentSpecs: {
          ...defaultInlineContentSpecs,
          inlineMath: inlineMathSpec,
        },
      }),
    [],
  );

  // `useCreateBlockNote` is generic over schema; the spec types in 0.46
  // don't quite line up with the augmented schema we just built, so accept
  // the cast on the way in. Nothing downstream depends on the precise
  // generic parameters — the editor itself is fully functional.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = useCreateBlockNote({ schema: schema as any });

  // Keep the latest onChange in a ref so the editor's change subscription
  // doesn't have to re-bind on every parent render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Parse the initial markdown once on mount. BlockNote can't take markdown
  // as a constructor arg, so we run a one-shot conversion + replaceBlocks.
  // `tryParseMarkdownToBlocks` is synchronous in 0.46; if parsing yields no
  // blocks we leave the editor empty so the user can recover by typing.
  //
  // The math pipeline runs in three steps:
  // 1. `preProcessDisplayMath` collapses multi-line `$$...$$` to one line so
  //    BlockNote keeps it inside a single paragraph node.
  // 2. After parse, `injectMathIntoBlocks` lifts inline `$...$` runs.
  // 3. Then `injectMathBlocks` lifts paragraphs that are nothing but `$$X$$`
  //    into `mathBlock` blocks for KaTeX display rendering.
  useEffect(() => {
    try {
      const normalised = preProcessDisplayMath(initialMarkdown);
      const raw = editor.tryParseMarkdownToBlocks(normalised);
      const withInline = injectMathIntoBlocks(raw as unknown as unknown[]);
      const withMath = injectMathBlocks(withInline) as typeof raw;
      if (withMath.length > 0) {
        editor.replaceBlocks(editor.document, withMath);
      }
    } catch {
      // Malformed markdown — surfacing a parse error here would only block
      // the user from recovering. Silently leave the editor empty.
    }
    // initialMarkdown is intentionally read once — re-applying it would
    // wipe the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Fire onChange with the latest markdown on every doc mutation. Each call
  // serialises the full document; for typical notes (<5 KB) this stays well
  // under a millisecond and the parent debounces the disk write on top. We
  // first flatten any `inlineMath` nodes back into `$...$` text so the
  // markdown saved to disk stays portable.
  useEffect(() => {
    return editor.onChange(() => {
      try {
        const flattened = extractMathToText(
          editor.document as unknown as unknown[],
        );
        const md = editor.blocksToMarkdownLossy(
          flattened as unknown as typeof editor.document,
        );
        onChangeRef.current(md);
      } catch {
        // Conversion failed for this tick — skip; the next change retries.
      }
    });
  }, [editor]);

  return (
    <div className="blocknote-host" data-theme-flavour={blockNoteTheme}>
      <BlockNoteView editor={editor} theme={blockNoteTheme} />
    </div>
  );
}
