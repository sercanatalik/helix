import { useEffect, useMemo, useState } from "react";
import { VegaEmbed } from "react-vega";
import type { Config } from "vega";
import type { VisualizationSpec } from "vega-embed";

// Vega's `Config` type only enumerates Vega-native mark keys (rect, symbol,
// rule, …) and rejects Vega-Lite ones (bar, point) under excess-property
// checking. Vega-embed forwards either flavor at runtime, so model the
// builder's output loosely and cast at the embed boundary.
type VegaLikeConfig = Record<string, unknown>;

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
    // paints the panel bg.
    if (parsed.background === undefined) parsed.background = "transparent";
    return { ok: true, spec: parsed as VisualizationSpec };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface ThemeTokens {
  readonly fg: string;
  readonly fgMuted: string;
  readonly fgDim: string;
  readonly border: string;
  readonly borderSubtle: string;
  readonly accent: string;
  readonly success: string;
  readonly danger: string;
  readonly warn: string;
  readonly fontSans: string;
  readonly themeId: string;
}

// CSS custom properties reference each other (--accent-raw uses --accent-h
// and --accent-c), so getPropertyValue returns the literal var() chain. We
// need the concrete computed color, which only the cascade can produce —
// resolve via a probe element painted with the var.
function readTokens(): ThemeTokens {
  const root = document.documentElement;
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);

  const colorOf = (varName: string): string => {
    probe.style.color = `var(${varName})`;
    return getComputedStyle(probe).color;
  };

  const rawOf = (varName: string): string =>
    getComputedStyle(root).getPropertyValue(varName).trim();

  try {
    return {
      fg: colorOf("--fg"),
      fgMuted: colorOf("--fg-muted"),
      fgDim: colorOf("--fg-dim"),
      border: colorOf("--border-raw"),
      borderSubtle: colorOf("--border-subtle"),
      accent: colorOf("--accent-raw"),
      success: colorOf("--success"),
      danger: colorOf("--danger"),
      warn: colorOf("--warn"),
      fontSans: rawOf("--font-sans") || "system-ui, sans-serif",
      themeId: root.getAttribute("data-theme") ?? "",
    };
  } finally {
    probe.remove();
  }
}

function useThemeTokens(): ThemeTokens | null {
  const [tokens, setTokens] = useState<ThemeTokens | null>(() =>
    typeof document === "undefined" ? null : readTokens(),
  );

  useEffect(() => {
    const refresh = () => setTokens(readTokens());
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return tokens;
}

// Map Helix tokens onto Vega's config tree. Categorical range pulls from the
// semantic tokens that every theme already defines, so the palette stays
// cohesive with the rest of the app instead of fighting it.
function buildConfig(tokens: ThemeTokens): VegaLikeConfig {
  const { fg, fgMuted, fgDim, border, borderSubtle, accent, success, danger, warn, fontSans } = tokens;

  const axis = {
    domainColor: border,
    gridColor: borderSubtle,
    tickColor: border,
    labelColor: fgMuted,
    titleColor: fg,
    labelFont: fontSans,
    titleFont: fontSans,
    labelFontSize: 11,
    titleFontSize: 12,
    titleFontWeight: 500 as const,
    titlePadding: 8,
    domainWidth: 1,
    tickWidth: 1,
    gridOpacity: 0.6,
  };

  return {
    background: "transparent",
    // `style.cell` is the vega-typings-friendly way to remove the default
    // chart frame; vega-lite's `view: { stroke: ... }` shorthand isn't on
    // the Vega Config type. Effect is the same.
    style: { cell: { stroke: "transparent" } },
    axis,
    axisX: { ...axis, labelAngle: 0 },
    axisY: { ...axis },
    legend: {
      labelColor: fgMuted,
      titleColor: fg,
      labelFont: fontSans,
      titleFont: fontSans,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 500,
      symbolStrokeWidth: 1.5,
    },
    title: {
      color: fg,
      subtitleColor: fgDim,
      font: fontSans,
      subtitleFont: fontSans,
      fontSize: 13,
      fontWeight: 600,
      anchor: "start",
      offset: 8,
    },
    mark: { fill: accent },
    arc: { fill: accent },
    area: { fill: accent, fillOpacity: 0.85 },
    bar: { fill: accent },
    line: { stroke: accent, strokeWidth: 2 },
    point: { fill: accent, stroke: accent, size: 60 },
    rect: { fill: accent },
    rule: { stroke: fgDim },
    text: { fill: fgMuted, font: fontSans },
    range: {
      // Categorical palette built from the theme's semantic tokens — same
      // colors used elsewhere in the app, so charts read as part of the UI.
      category: [accent, success, warn, danger, fgMuted, fgDim],
      ramp: { scheme: "viridis" },
      heatmap: { scheme: "viridis" },
      ordinal: [accent, success, warn, danger, fgMuted, fgDim],
    },
  };
}

export function VegaChart({ code, language, isIncomplete }: VegaChartProps) {
  const tokens = useThemeTokens();
  const parsed = useMemo(() => parseSpec(code, language), [code, language]);
  const config = useMemo(() => (tokens ? buildConfig(tokens) : undefined), [tokens]);
  // Re-mount the embed when the theme flips so vega rebuilds scales/legends
  // against the new config rather than diffing the old palette in place.
  const themeKey = tokens?.themeId ?? "default";

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
        key={themeKey}
        spec={parsed.spec}
        options={{
          actions: { export: true, source: false, compiled: false, editor: false },
          renderer: "canvas",
          config: config as Config | undefined,
          tooltip: { theme: tokens?.themeId.includes("dark") ? "dark" : "light" },
        }}
      />
    </div>
  );
}
