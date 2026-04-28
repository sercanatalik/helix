import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";

// Module-level instances keep prop identity stable so streaming patches
// don't defeat Streamdown's memo. Without these plugins, $…$/$$…$$ stay as
// raw text and fenced code blocks render unhighlighted.
export const STREAMDOWN_PLUGINS = {
  code,
  math: createMathPlugin({
    singleDollarTextMath: true,
    errorColor: "var(--danger)",
  }),
};
