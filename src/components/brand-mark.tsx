// Helix brand mark — pointy-top hexagon with a thin diagonal stroke as a
// rotational hint, lifted from the Meridian Theme Proposal. Renders at
// currentColor so it inherits --accent-raw via the .brand-mark host.

interface BrandMarkProps {
  readonly size?: number;
}

export function BrandMark({ size = 22 }: BrandMarkProps) {
  const path = "M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z";
  return (
    <span
      className="brand-mark"
      data-shape="hexagon"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d={path} fill="currentColor" opacity="0.14" />
        <path d={path} />
        <path d="M9 9 L15 15" opacity="0.7" />
      </svg>
    </span>
  );
}
