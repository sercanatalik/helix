import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";

interface CodeMirrorEditorProps {
  /** Initial document content. Re-applied only when the underlying note id
   * changes (handled by the parent's `key` prop) — subsequent prop drift
   * doesn't replace what the user has typed. */
  readonly initialDoc: string;
  /** Fires on every document change with the latest text. The parent
   * debounces saves on top of this. */
  readonly onChange: (next: string) => void;
}

/** Hand-rolled CodeMirror 6 React wrapper. We avoid `@uiw/react-codemirror`
 * to stay in control of the lifecycle (single mount per note id, no
 * re-render thrash) and keep the dependency surface small. */
export function CodeMirrorEditor({ initialDoc, onChange }: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Latest onChange in a ref so the EditorView callback never holds a stale
  // closure but we don't have to recreate the view on every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        history(),
        lineNumbers(),
        bracketMatching(),
        indentOnInput(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        // Match the chat transcript's streamdown body: same 14px / 1.62
        // rhythm and the app's --font-mono token so a markdown file in the
        // raw editor reads at the same scale as the rendered chat output.
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "14px",
            color: "var(--fg)",
          },
          ".cm-scroller": {
            fontFamily: "var(--font-mono)",
            lineHeight: "1.62",
          },
          ".cm-content": {
            padding: "16px 4px",
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => view.destroy();
    // initialDoc is intentionally part of the mount step only — the parent
    // remounts via `key={noteId}` when switching notes, so we never need to
    // reactively swap the doc here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="codemirror-host" />;
}
