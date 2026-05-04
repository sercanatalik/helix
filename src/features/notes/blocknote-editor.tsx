import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import {
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { codeBlockOptions } from "@blocknote/code-block";
import { createClient } from "../../lib/llm/client";
import type { ProviderConfig } from "../providers";
import { useProviders } from "../providers";
import { inlineMathSpec } from "./inline-math";
import { mathBlockSpec } from "./math-block";
import { vegaBlockSpec } from "./vega-block";
import {
  extractMathToText,
  injectMathBlocks,
  injectMathIntoBlocks,
  preProcessDisplayMath,
} from "./inject-math";
import { extractVegaToCodeBlocks, injectVegaBlocks } from "./inject-vega";
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
          vegaBlock: vegaBlockSpec,
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
      const withMath = injectMathBlocks(withInline);
      // Lift any vega-lite / vega code blocks (and ```json blocks holding a
      // Vega spec) into our `vegaBlock` so the chart renders inline.
      const withVega = injectVegaBlocks(withMath) as typeof raw;
      if (withVega.length > 0) {
        editor.replaceBlocks(editor.document, withVega);
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
        // Vega blocks first → fenced code blocks; then math collapses back
        // to `$$...$$` paragraphs. Order matters because `extractMathToText`
        // also returns paragraph nodes the vega walker would skip anyway,
        // but doing vega first avoids any future cross-talk.
        const withoutVega = extractVegaToCodeBlocks(
          editor.document as unknown as unknown[],
        );
        const flattened = extractMathToText(withoutVega);
        const md = editor.blocksToMarkdownLossy(
          flattened as unknown as typeof editor.document,
        );
        onChangeRef.current(md);
      } catch {
        // Conversion failed for this tick — skip; the next change retries.
      }
    });
  }, [editor]);

  // Resolve the active provider once on mount and keep the latest in a
  // ref so the toolbar's inline-LLM call (which renders inside BlockNote's
  // portal) always reads the current value without a remount churn.
  const { activeProvider } = useProviders();
  const providerRef = useRef(activeProvider);
  useEffect(() => {
    providerRef.current = activeProvider;
  }, [activeProvider]);

  // The custom toolbar leads with an "Ask AI" input so a selection can be
  // edited inline without leaving the note. The default formatting
  // buttons sit after it. Memoised so BlockNote doesn't re-mount the
  // toolbar component on every editor render.
  const CustomFormattingToolbar = useMemo(
    () =>
      function CustomFormattingToolbarInner() {
        return (
          <FormattingToolbar>
            <AskAiToolbarItem providerRef={providerRef} />
            {getFormattingToolbarItems()}
          </FormattingToolbar>
        );
      },
    [],
  );

  return (
    <div className="blocknote-host" data-theme-flavour={blockNoteTheme}>
      <BlockNoteView
        editor={editor}
        theme={blockNoteTheme}
        formattingToolbar={false}
      >
        <FormattingToolbarController
          formattingToolbar={CustomFormattingToolbar}
        />
      </BlockNoteView>
    </div>
  );
}

/** Inline "Ask AI" prompt input rendered as the first item in the
 * formatting toolbar. The user types an instruction; on Enter we make a
 * direct streaming chat-completions call to the active provider and
 * replace the selected text in the editor with the response as it
 * streams. No chat session, no transcript — the answer lands in the doc.
 *
 * Streaming strategy: snapshot the original selection's `from` position
 * (in ProseMirror coordinates), then on each delta dispatch a
 * transaction that replaces `[from, currentEnd]` with the running
 * accumulator. `from` is stable because nothing is inserted before it;
 * positions after the selection shift, but the toolbar is anchored to
 * this selection so the user typically isn't editing elsewhere. History
 * entries from intermediate transactions are suppressed so undo
 * collapses the whole AI edit into one step. */
function AskAiToolbarItem({
  providerRef,
}: {
  readonly providerRef: MutableRefObject<ProviderConfig | undefined>;
}) {
  const editor = useBlockNoteEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Captured selection range. We snap it BEFORE focus shifts to the
  // input — by `submit` time the editor has lost focus and ProseMirror
  // may have collapsed `view.state.selection` to a cursor. Reading from
  // a ref captured on toolbar mount + on every editor mousedown
  // sidesteps that.
  const selectionRef = useRef<{
    readonly from: number;
    readonly to: number;
    readonly text: string;
  } | null>(null);
  // Abort handle for the active stream.
  const abortRef = useRef<AbortController | null>(null);

  const captureSelection = useCallback(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    const { from, to } = view.state.selection;
    if (from === to) return;
    const text = view.state.doc.textBetween(from, to, "\n");
    if (!text.trim()) return;
    selectionRef.current = { from, to, text };
  }, [editor]);

  // Capture the selection eagerly on every render where the user isn't
  // actively typing into the input. The toolbar only renders when there
  // IS a selection in the editor, so this lands in the ref the first
  // time we mount and refreshes if the user re-selects before clicking
  // into the input.
  useEffect(() => {
    if (streaming) return;
    if (
      typeof document !== "undefined" &&
      document.activeElement === inputRef.current
    ) {
      return;
    }
    captureSelection();
  });

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (streaming) return;
    const provider = providerRef.current;
    if (!provider) {
      setError("No active provider. Open Settings to add one.");
      return;
    }
    const model = provider.model;
    if (!model) {
      setError(`Provider "${provider.name}" has no default model set.`);
      return;
    }
    const captured = selectionRef.current;
    if (!captured) {
      setError("Selection lost — re-select and try again.");
      return;
    }
    const { from, to, text: selectedText } = captured;

    setError(undefined);
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const client = createClient(provider);
      const stream = client.chatStream(
        {
          model,
          messages: [
            {
              role: "user",
              content: `${trimmed}\n\nText:\n"""\n${selectedText}\n"""\n\nReply with the replacement text only — no preamble, no quotation marks, no commentary.`,
            },
          ],
          stream: true,
        },
        { signal: ac.signal },
      );

      // Buffer the full response, then do one transaction. Per-delta
      // dispatch was easy to get subtly wrong (positions, focus, history)
      // and an inline edit looks the same to the user either way once
      // the model finishes — usually under a second for a short reply.
      let acc = "";
      for await (const chunk of stream) {
        if (ac.signal.aborted) break;
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) acc += delta;
      }
      if (ac.signal.aborted) return;
      if (!acc.trim()) {
        setError("Model returned no content.");
        return;
      }

      const liveView = editor.prosemirrorView;
      const tr = liveView.state.tr;
      tr.insertText(acc, from, to);
      liveView.dispatch(tr);
      setPrompt("");
      // Refresh the captured selection to the freshly-inserted range so
      // a follow-up ask on the same span (e.g. "shorter") works.
      selectionRef.current = {
        from,
        to: from + acc.length,
        text: acc,
      };
    } catch (e) {
      if (!ac.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [prompt, streaming, providerRef, editor]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      // Stop the editor and toolbar focus trap from seeing these — Enter
      // would otherwise split the block, Esc bubbles into other BlockNote
      // shortcuts, and arrow keys would steer the selection in the doc.
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        if (streaming) cancel();
        else void submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (streaming) cancel();
        setPrompt("");
        setError(undefined);
      }
    },
    [submit, cancel, streaming],
  );

  // Cancel any in-flight stream when the toolbar unmounts (selection
  // change, click outside). Without this an aborted user flow would
  // keep streaming into the document under the cursor.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // What the input shows. While streaming we display a status message
  // in `value` so the user sees feedback even with a non-empty prompt.
  // Errors get the same treatment so they don't hide behind the
  // placeholder when the user has typed.
  const displayValue = streaming
    ? "Asking… ⏎ to cancel"
    : error
      ? error
      : prompt;
  const displayReadOnly = streaming || !!error;

  return (
    <input
      ref={inputRef}
      className="bn-ask-ai"
      type="text"
      value={displayValue}
      readOnly={displayReadOnly}
      onChange={(e) => {
        if (streaming) return;
        if (error) {
          // Any keystroke clears the error and starts fresh.
          setError(undefined);
          setPrompt(e.target.value);
          return;
        }
        setPrompt(e.target.value);
      }}
      onKeyDown={onKeyDown}
      // Capture the editor selection BEFORE focus shifts away — onFocus
      // is too late, the editor is already blurred by then.
      onMouseDown={(e) => {
        e.stopPropagation();
        captureSelection();
      }}
      onFocus={() => {
        // Belt-and-braces: if mousedown didn't capture (e.g. tab focus),
        // try once more before the editor's blur reaches its handler.
        if (!selectionRef.current) captureSelection();
      }}
      placeholder="Ask AI…"
      aria-label="Ask AI about the selected text"
      data-streaming={streaming || undefined}
      data-error={error ? "true" : undefined}
    />
  );
}
