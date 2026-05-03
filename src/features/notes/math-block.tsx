import { useMemo } from "react";
import katex from "katex";
import { createReactBlockSpec } from "@blocknote/react";

/** Display-math block. The latex source lives in the `latex` prop; the
 * block has no inline content (`content: "none"`) so the rendered output
 * is the entire visual surface — clicking it opens a small editor in the
 * future, for now you edit by switching to raw mode and updating `$$...$$`.
 *
 * `createReactBlockSpec` returns a *factory* — call it once to bake the
 * options into a usable BlockSpec for the schema. */
export const mathBlockSpec = createReactBlockSpec(
  {
    type: "mathBlock" as const,
    content: "none",
    propSchema: {
      latex: { default: "" },
    },
  },
  {
    render: ({ block }) => {
      const latex = (block.props as { latex?: string }).latex ?? "";
      const html = useMemo(() => {
        try {
          return katex.renderToString(latex, {
            throwOnError: false,
            displayMode: true,
            output: "html",
          });
        } catch {
          return latex;
        }
      }, [latex]);
      return (
        <div
          className="bn-math-block"
          contentEditable={false}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    },
  },
)();
