import { lazy, Suspense } from "react";

interface VegaChartProps {
  readonly code: string;
  readonly language: string;
  readonly isIncomplete: boolean;
}

// React.lazy on a dynamic import puts vega/vega-lite/vega-embed into their
// own chunks — they're ~600KB+ minified and only needed when a message
// actually contains a ```vega-lite / ```vega artifact.
const VegaChartImpl = lazy(() =>
  import("./vega-chart-impl").then((m) => ({ default: m.VegaChart })),
);

function PendingFallback({ label }: { readonly label: string }) {
  return (
    <div className="vega-chart vega-chart--pending" role="status">
      <span className="vega-chart-pending-label">{label}</span>
    </div>
  );
}

export function VegaChart({ code, language, isIncomplete }: VegaChartProps) {
  // Always mount the impl — it does its own structural check and only shows
  // the pending state while the JSON skeleton is still unbalanced. The
  // outer `isIncomplete` flag from streamdown isn't reliable when content
  // is patched in atomically (e.g. tool-result harvest), which would leave
  // a complete spec stuck on "rendering chart…" forever.
  return (
    <Suspense fallback={<PendingFallback label="loading chart engine…" />}>
      <VegaChartImpl code={code} language={language} isIncomplete={isIncomplete} />
    </Suspense>
  );
}
