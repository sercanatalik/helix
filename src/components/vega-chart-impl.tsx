import { useEffect, useMemo, useRef, useState } from "react";
import type { Config } from "vega";
import type { Result, VisualizationSpec } from "vega-embed";

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
  | {
      ok: true;
      spec: VisualizationSpec;
      /** The fenced language tag (`vega`, `vega-lite`, `vegalite`). Forwarded
       * to `vegaEmbed` as `mode`, so the compiler is picked by the block tag
       * rather than a hardcoded `$schema` URL. */
      language: string;
    }
  | { ok: false; error: string; pending: boolean };

/** A streamed code block can end mid-token while `isIncomplete` is briefly
 * stale. Treat the spec as still-loading when its JSON skeleton hasn't
 * closed yet — same braces / brackets balance, ends on `}` or `]`. */
function looksComplete(code: string): boolean {
  const last = code.slice(-1);
  if (last !== "}" && last !== "]") return false;
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const c of code) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
  }
  return braces === 0 && brackets === 0 && !inString;
}

/** Repair common LLM-generated JSON quirks before handing off to JSON.parse:
 * - Strip `// line` and `/* block * /` comments (models occasionally emit them).
 * - Escape literal newlines / tabs / carriage returns that appear inside
 *   string literals — the prime cause of "Unterminated string" errors when
 *   a model breaks a long description across lines.
 * - Drop trailing commas before `]` and `}`. */
function repairJson(input: string): string {
  // Strip block comments first (so a `/*` inside a string doesn't get
  // mistaken for a comment by the line-comment pass).
  let s = input.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip `//` line comments only when they're not inside a string. Cheap
  // approximation: only strip when the start of the line (or preceded by
  // whitespace + non-quote) starts with `//`.
  s = s
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx < 0) return line;
      // Don't strip if there's an unbalanced `"` count before `//` — likely
      // inside a string literal.
      const before = line.slice(0, idx);
      const quotes = (before.match(/(?:^|[^\\])"/g) ?? []).length;
      if (quotes % 2 === 1) return line;
      return before;
    })
    .join("\n");

  // Walk char by char to escape literal control chars inside strings.
  const out: string[] = [];
  let inString = false;
  let escape = false;
  for (const c of s) {
    if (inString) {
      if (escape) {
        out.push(c);
        escape = false;
        continue;
      }
      if (c === "\\") {
        out.push(c);
        escape = true;
        continue;
      }
      if (c === '"') {
        out.push(c);
        inString = false;
        continue;
      }
      if (c === "\n") {
        out.push("\\n");
        continue;
      }
      if (c === "\r") {
        out.push("\\r");
        continue;
      }
      if (c === "\t") {
        out.push("\\t");
        continue;
      }
      out.push(c);
    } else {
      if (c === '"') inString = true;
      out.push(c);
    }
  }
  s = out.join("");

  // Drop trailing commas: `[1, 2, 3,]` → `[1, 2, 3]`.
  s = s.replace(/,(\s*[}\]])/g, "$1");

  return s;
}

// Vega-Lite specs without an explicit $schema still work with vega-embed —
// it falls back to vega-lite mode. We pick the compiler mode via the embed
// options instead of injecting a $schema URL into the spec, so the bundle
// has zero references to vega.github.io.
function parseSpec(code: string, language: string): ParseResult {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, error: "empty spec", pending: true };
  }

  // Fast path: most well-formed specs go straight through.
  let parsed: Record<string, unknown> | null = null;
  let firstError: unknown = null;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    firstError = err;
  }

  // Fall back to a repaired version if the strict parse failed.
  if (!parsed) {
    try {
      parsed = JSON.parse(repairJson(trimmed)) as Record<string, unknown>;
    } catch {
      // Treat as "still streaming" if the brace/bracket structure isn't
      // balanced yet — the renderer will show a pending state instead of
      // a red error.
      const pending = !looksComplete(trimmed);
      const message =
        firstError instanceof Error
          ? firstError.message
          : String(firstError);
      return { ok: false, error: message, pending };
    }
  }

  if (parsed.background === undefined) parsed.background = "transparent";
  // Strip any $schema the model emitted — keeping it would still pass the
  // string into vega-embed, and even though embed never *fetches* it, the
  // less the chart references vega.github.io the cleaner the audit.
  if ("$schema" in parsed) delete parsed.$schema;
  return { ok: true, spec: parsed as VisualizationSpec, language };
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

  // Pending only when our own parse failed AND the JSON skeleton isn't
  // closed yet. We deliberately ignore streamdown's `isIncomplete` here:
  // when content is patched in atomically (tool-result harvest, replayed
  // sessions) it can lie about a complete block, and we don't want a valid
  // spec stuck behind a stale flag. Once the brace/bracket balance is good
  // the fast/repair JSON.parse path will succeed and we'll render.
  void isIncomplete;
  if (!parsed.ok && parsed.pending) {
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
    <ChartHost
      spec={parsed.spec}
      language={parsed.language}
      config={config}
      tokens={tokens}
    />
  );
}

/** Run vega-embed directly against a ref'd div. We bypass `react-vega` so:
 *  1. `"width": "container"` is measured against the actual host element
 *     instead of a wrapper component that may render at intrinsic width.
 *  2. A ResizeObserver re-renders the chart when the container resizes,
 *     so a chart that originally fit a 600px panel reflows when the
 *     workspace tree opens or the window resizes. */
function ChartHost({
  spec,
  language,
  config,
  tokens,
}: {
  readonly spec: VisualizationSpec;
  readonly language: string;
  readonly config: VegaLikeConfig | undefined;
  readonly tokens: ThemeTokens | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Cache the latest result so the ResizeObserver tear-down knows what to
  // finalize between renders. Tracking via ref dodges the re-render cascade
  // a useState would trigger on every observer tick.
  const viewRef = useRef<Result["view"] | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    async function render() {
      // Tauri's CSP forbids `unsafe-eval`, but vega-lite's default expression
      // compiler builds `new Function(...)` runtimes for every formula
      // transform / signal. The interpreter walks an AST instead — slower
      // for huge specs, but safe under our CSP. Pair it with `ast: true` so
      // vega emits the AST form vega-interpreter expects.
      const [{ default: vegaEmbed }, { expressionInterpreter }] =
        await Promise.all([
          import("vega-embed"),
          import("vega-interpreter"),
        ]);
      if (cancelled || !hostRef.current) return;
      // Drop the previous view before mounting a new one — vega-embed leaks
      // canvases otherwise when re-running on resize.
      if (viewRef.current) {
        viewRef.current.finalize();
        viewRef.current = null;
      }
      // `mode` picks the compiler from the fenced language tag (no $schema
      // URL needed). Default to vega-lite for any unrecognised tag.
      const mode = language === "vega" ? "vega" : "vega-lite";
      try {
        const result = await vegaEmbed(hostRef.current, spec, {
          mode,
          // Disable the built-in three-dot action menu — the dedicated Save
          // button on the chart toolbar handles PNG + data export with a
          // single click, which is the action users actually want.
          actions: false,
          renderer: "canvas",
          ast: true,
          expr: expressionInterpreter,
          config: config as Config | undefined,
          tooltip: { theme: tokens?.themeId.includes("dark") ? "dark" : "light" },
        });
        if (cancelled) {
          result.finalize();
          return;
        }
        viewRef.current = result.view;
        setReady(true);
      } catch (err) {
        // Render-time errors (e.g. an invalid scheme on the config) land
        // here. Surface them inside the host div so the user sees something
        // actionable instead of an empty box.
        const target = hostRef.current;
        if (!target) return;
        const message = err instanceof Error ? err.message : String(err);
        target.textContent = `Vega render failed: ${message}`;
        target.setAttribute("data-vega-failed", "true");
        setReady(false);
      }
    }

    void render();

    // Re-run on resize so `width: "container"` reflows. Debounce to a
    // single rAF tick so dragging a window edge doesn't queue dozens of
    // embeds back-to-back.
    let frame: number | null = null;
    observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!cancelled) void render();
      });
    });
    observer.observe(host);

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      if (viewRef.current) {
        viewRef.current.finalize();
        viewRef.current = null;
      }
      setReady(false);
    };
  }, [spec, language, config, tokens]);

  const baseName = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = chartSlug(spec);
    return slug ? `chart-${slug}-${stamp}` : `chart-${stamp}`;
  };

  const onSavePng = async () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      // Render to a 2x canvas, then go canvas → Blob → object URL. Tauri's
      // webview often refuses `<a download>` on a `data:` URL once it gets
      // big (a high-DPI chart easily blows past the limit), but `blob:` URLs
      // produced from `URL.createObjectURL` download reliably.
      const canvas = await view.toCanvas(2);
      const pngBlob = await canvasToBlob(canvas, "image/png");
      if (pngBlob) downloadBlob(pngBlob, `${baseName()}.png`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("chart png save failed", err);
    }
  };

  const onSaveCsv = () => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const rows = extractRows(spec, view);
      if (!rows || rows.length === 0) return;
      const csv = toCsv(rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, `${baseName()}.csv`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("chart csv save failed", err);
    }
  };

  return (
    <div className="vega-chart">
      {ready && (
        <div className="vega-chart-actions">
          <button
            type="button"
            className="vega-chart-save"
            onClick={onSavePng}
            aria-label="Save chart as PNG"
            title="Save chart as PNG"
          >
            <DownloadIcon />
          </button>
          <button
            type="button"
            className="vega-chart-save"
            onClick={onSaveCsv}
            aria-label="Download chart data as CSV"
            title="Download data as CSV"
          >
            <CsvIcon />
          </button>
        </div>
      )}
      <div ref={hostRef} className="vega-chart-host" />
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// Spreadsheet glyph: a small "table" with a "CSV" badge feel — rendered as a
// rectangle with two grid divisions so it reads as tabular data at 13px.
function CsvIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="10" y1="4" x2="10" y2="20" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </svg>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the webview has time to start the download — revoking
  // synchronously occasionally cancels the in-flight save in Tauri/WebKit.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), type);
  });
}

// Pull the row-shaped dataset behind the rendered chart. Inline `data.values`
// is the common case for chat-rendered specs; fall back to the compiled
// view's default `source_0` dataset so charts that use top-level `datasets`
// or transforms still produce a CSV. Only an array of plain objects is
// useful for tabular export — we return null for anything else so the caller
// can skip the download cleanly.
function extractRows(
  spec: VisualizationSpec,
  view: Result["view"],
): Record<string, unknown>[] | null {
  const s = spec as Record<string, unknown>;
  const data = s.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.values) && rowsLike(data.values)) {
    return data.values as Record<string, unknown>[];
  }
  try {
    const rows = view.data("source_0") as unknown;
    if (Array.isArray(rows) && rows.length && rowsLike(rows)) {
      return rows as Record<string, unknown>[];
    }
  } catch {
    // view may not have that dataset
  }
  return null;
}

function rowsLike(arr: unknown[]): boolean {
  return arr.every((r) => r !== null && typeof r === "object" && !Array.isArray(r));
}

// CSV serialiser: union of keys across all rows for the header, then escape
// each cell per RFC 4180 (wrap in quotes when the value contains a comma,
// quote, or newline; double up embedded quotes). Vega adds internal symbol
// keys prefixed with `_` to source rows after compilation — strip those so
// the export stays close to the user's original data shape.
function toCsv(rows: Record<string, unknown>[]): string {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!k.startsWith("_")) keys.add(k);
    }
  }
  const headers = Array.from(keys);
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s =
      typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

// Title → kebab slug for the download filename. Vega-Lite accepts a string
// or an object with `text`; both forms get sanitised down to a short slug.
function chartSlug(spec: VisualizationSpec): string {
  const t = (spec as { title?: unknown }).title;
  let raw = "";
  if (typeof t === "string") raw = t;
  else if (t && typeof t === "object" && "text" in t) {
    const text = (t as { text?: unknown }).text;
    if (typeof text === "string") raw = text;
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
