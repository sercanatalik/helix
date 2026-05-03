import { createReactBlockSpec } from "@blocknote/react";
import { VegaChart } from "../../components/vega-chart";

/** Display-vega block. The spec source lives in the `spec` prop; the block
 * has no inline content (`content: "none"`) so the rendered chart is the
 * entire visual surface. Edit the underlying source in raw mode.
 *
 * Mirrors `mathBlockSpec` — `createReactBlockSpec` returns a factory we
 * call once to bake in the props for inclusion in the schema. */
export const vegaBlockSpec = createReactBlockSpec(
  {
    type: "vegaBlock" as const,
    content: "none",
    propSchema: {
      spec: { default: "" },
      // `vega-lite | vegalite | vega` — kept verbatim so the round-trip
      // back to a fenced code block restores the same language tag.
      language: { default: "vega-lite" },
    },
  },
  {
    render: ({ block }) => {
      const props = block.props as { spec?: string; language?: string };
      const spec = props.spec ?? "";
      const language = props.language ?? "vega-lite";
      // One-line trace per mount so we can confirm BlockNote actually
      // renders our custom block (vs. silently dropping it from the schema).
      // eslint-disable-next-line no-console
      console.log(
        `[vega-block] render lang=${language} spec.len=${spec.length}`,
      );
      return (
        <div className="bn-vega-block" contentEditable={false}>
          <VegaChart code={spec} language={language} isIncomplete={false} />
        </div>
      );
    },
  },
)();
