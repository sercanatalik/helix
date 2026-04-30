import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { VegaChart } from "../../components/vega-chart";

// Vitesse pair (antfu) — restrained, slightly desaturated palette that pairs
// well with Meridian's "structured ledger" aesthetic: warm yellows for
// strings, cool blues for keywords, muted grey-green comments. Shiki emits
// dual --shiki-light / --shiki-dark CSS vars; the active variant is selected
// by data-theme rules in styles/components.css.
const code = createCodePlugin({
  themes: ["vitesse-light", "vitesse-dark"],
});

// Module-level instances keep prop identity stable so streaming patches
// don't defeat Streamdown's memo. Without these plugins, $…$/$$…$$ stay as
// raw text and fenced code blocks render unhighlighted.
export const STREAMDOWN_PLUGINS = {
  code,
  math: createMathPlugin({
    singleDollarTextMath: true,
    errorColor: "var(--danger)",
  }),
  renderers: [
    {
      language: ["vega-lite", "vegalite", "vega"],
      component: VegaChart,
    },
  ],
};
