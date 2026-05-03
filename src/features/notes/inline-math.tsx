import { useMemo } from "react";
import katex from "katex";
import { createReactInlineContentSpec } from "@blocknote/react";
import "katex/dist/katex.min.css";

/** Custom inline content node that renders LaTeX via KaTeX. The `latex`
 * prop holds the source — the editor never edits the rendered HTML
 * directly, only the underlying text. Round-tripping with markdown is
 * handled by `inject-math.ts`'s pre/post processors so `$...$` survives
 * a save/load cycle. */
export const inlineMathSpec = createReactInlineContentSpec(
  {
    type: "inlineMath" as const,
    content: "none",
    propSchema: {
      latex: { default: "" },
    },
  },
  {
    render: ({ inlineContent }) => {
      const latex = (inlineContent.props as { latex?: string }).latex ?? "";
      const html = useMemo(() => {
        try {
          return katex.renderToString(latex, {
            throwOnError: false,
            displayMode: false,
            output: "html",
          });
        } catch {
          // KaTeX surfaces parse errors via `throwOnError: false` already;
          // this catches anything pathological so a bad expression doesn't
          // blow up the whole editor.
          return latex;
        }
      }, [latex]);
      return (
        <span
          className="bn-inline-math"
          contentEditable={false}
          // The rendered output is sanitized markup straight from KaTeX
          // (no user HTML), so dangerouslySetInnerHTML is safe here.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    },
  },
);
