import { BrandMark } from "./components/brand-mark";

interface TitlebarProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
}

export function Titlebar({ title, subtitle, onBack }: TitlebarProps) {
  return (
    <header className="titlebar">
      <BrandLogo />
      <span className="titlebar-divider" aria-hidden />
      <div className="titlebar-drag">
        <span className="titlebar-title">{title}</span>
        {subtitle ? (
          <span className="breadcrumb">
            <span className="breadcrumb-sep">/</span>
            <span>{subtitle}</span>
          </span>
        ) : null}
      </div>
      {onBack ? (
        <button
          type="button"
          className="titlebar-icon-btn"
          onClick={onBack}
          title="Back"
          aria-label="Back"
        >
          <BackIcon />
        </button>
      ) : null}
    </header>
  );
}

function BrandLogo() {
  return (
    <div className="brand" aria-label="Helix AI">
      <BrandMark shape="hexagon" />
      <span className="brand-text">
        <span className="brand-title">
          <b>Helix</b> <span className="brand-sub-name">AI</span>
        </span>
      </span>
    </div>
  );
}

function BackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}
