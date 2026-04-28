import { Markdown } from "../../components/markdown";

const WELCOME = `Welcome to **Helix AI**. This is a layout-only scaffold — no LLM is wired
up yet. The design is modular: change the active theme from \`Settings →
Appearance\`.

Add a new theme by dropping a CSS file under \`src/themes/\` and registering
it in \`src/themes/index.ts\`.

\`\`\`ts
import "./meridian-light.css";

export const THEMES = [
  { id: "meridian-light", label: "Meridian Light" },
] as const;
\`\`\`

Inline math like $E = mc^2$ and a display block:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt{\\pi}}{2}$$
`;

export function Transcript() {
  return (
    <section className="transcript scroll">
      <div className="transcript-inner">
        <div className="msg">
          <div className="msg-role" data-role="assistant">
            assistant
          </div>
          <div className="msg-content">
            <Markdown content={WELCOME} />
          </div>
        </div>
      </div>
    </section>
  );
}
