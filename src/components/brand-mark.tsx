// Original geometric brand marks for Helix's Meridian theme.
//
// Lifted from the Meridian Theme Proposal (logo-marks.jsx). Each mark renders
// at currentColor so it inherits --accent-raw via the .brand-mark host. The
// proposal supported a tweakable shape selector; here we expose the same set
// and default to the hexagon, which is the Helix brand mark.

const STROKE = 1.6;

export type BrandMarkShape =
  | "helix"
  | "hexagon"
  | "chevron"
  | "quadrant"
  | "monogram";

interface BrandMarkProps {
  readonly shape?: BrandMarkShape;
  readonly filled?: boolean;
  readonly size?: number;
}

export function BrandMark({
  shape = "hexagon",
  filled = true,
  size = 22,
}: BrandMarkProps) {
  if (shape === "monogram") {
    return <span className="brand-mark">hx</span>;
  }
  return (
    <span
      className="brand-mark"
      data-shape={shape}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {renderShape(shape, filled)}
    </span>
  );
}

function renderShape(shape: Exclude<BrandMarkShape, "monogram">, filled: boolean) {
  switch (shape) {
    case "helix":
      return <MarkHelix filled={filled} />;
    case "hexagon":
      return <MarkHexagon filled={filled} />;
    case "chevron":
      return <MarkChevron filled={filled} />;
    case "quadrant":
      return <MarkQuadrant filled={filled} />;
  }
}

function MarkHelix({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      {filled ? (
        <circle cx="12" cy="12" r="9.5" fill="currentColor" opacity="0.14" />
      ) : null}
      <circle cx="12" cy="12" r="9.5" />
      <path d="M7 6 C 17 10, 7 14, 17 18" opacity="0.85" />
    </svg>
  );
}

function MarkHexagon({ filled }: { filled: boolean }) {
  const path = "M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z";
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      {filled ? <path d={path} fill="currentColor" opacity="0.14" /> : null}
      <path d={path} />
      <path d="M9 9 L15 15" opacity="0.7" />
    </svg>
  );
}

function MarkChevron({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      {filled ? (
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="3"
          fill="currentColor"
          opacity="0.14"
        />
      ) : null}
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M9 8 L13 12 L9 16" opacity="0.85" />
      <path d="M14 8 L18 12 L14 16" opacity="0.55" />
    </svg>
  );
}

function MarkQuadrant({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinejoin="round"
      aria-hidden
    >
      {filled ? (
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="2"
          fill="currentColor"
          opacity="0.14"
        />
      ) : null}
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12 H21 M12 3 V21" opacity="0.7" />
    </svg>
  );
}
