import { useEffect, useMemo, useState } from "react";
import { VegaEmbed } from "react-vega";
import type { VisualizationSpec } from "vega-embed";

interface VegaChartProps {
  readonly code: string;
  readonly language: string;
  readonly isIncomplete: boolean;
}

type ParseResult =
  | { ok: true; spec: VisualizationSpec }
  | { ok: false; error: string };

// Vega-Lite specs without an explicit $schema still work with vega-embed —
// it falls back to vega-lite mode. For raw `vega` blocks, point $schema at
// the Vega schema so embed picks the correct compiler.
function parseSpec(code: string, language: string): ParseResult {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: "empty spec" };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (language === "vega" && !parsed.$schema) {
      parsed.$schema = "https://vega.github.io/schema/vega/v6.json";
    }
    // Let the chat surface show through — the .vega-chart container already
    // paints the panel bg. Spec-level `background` overrides theme defaults.
    if (parsed.background === undefined) parsed.background = "transparent";
    return { ok: true, spec: parsed as VisualizationSpec };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Map Helix theme tokens onto a vega-themes preset so chart fill/stroke/text
// pick up the right contrast for the current surface.
function pickVegaTheme(themeAttr: string | null): "dark" | undefined {
  if (!themeAttr) return undefined;
  return themeAttr.includes("dark") ? "dark" : undefined;
}

function useVegaTheme(): "dark" | undefined {
  const read = () =>
    pickVegaTheme(
      typeof document === "undefined"
        ? null
        : document.documentElement.getAttribute("data-theme"),
    );
  const [theme, setTheme] = useState<"dark" | undefined>(read);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

export function VegaChart({ code, language, isIncomplete }: VegaChartProps) {
  const theme = useVegaTheme();
  const parsed = useMemo(() => parseSpec(code, language), [code, language]);

  if (isIncomplete) {
    return (
      <div className="vega-chart vega-chart--pending" role="status">
        <span className="vega-chart-pending-label">rendering chart…</span>
      </div>
    );
  }

  if (!parsed.ok) {
    return (
      <div className="vega-chart vega-chart--error" role="alert">
        <div className="vega-chart-error-head">invalid {language} spec</div>
        <pre className="vega-chart-error-body">{parsed.error}</pre>
      </div>
    );
  }

  return (
    <div className="vega-chart">
      <VegaEmbed
        spec={parsed.spec}
        options={{
          actions: { export: true, source: false, compiled: false, editor: false },
          renderer: "canvas",
          theme,
          tooltip: { theme: theme === "dark" ? "dark" : "light" },
        }}
      />
    </div>
  );
}
