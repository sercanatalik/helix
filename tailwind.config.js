/** @type {import('tailwindcss').Config} */
// Tailwind sits on top of helix's existing CSS-variable theme tokens.
// We disable preflight so the hand-written reset in src/styles/base.css and
// the data-theme tokens stay authoritative — components read tokens via
// arbitrary-value utilities like `bg-[var(--bg-elev)]`.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Inter Tight"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: ['"JetBrains Mono"', "ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
