import { BrandMark } from "./brand-mark";
import { Button, Separator } from "../components/ui";

interface TitlebarProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: () => void;
}

export function Titlebar({ title, subtitle, onBack }: TitlebarProps) {
  return (
    <header className="titlebar">
      <BrandLogo />
      <Separator orientation="vertical" />
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
        <Button
          variant="icon"
          size="icon"
          onClick={onBack}
          title="Back"
          aria-label="Back"
        >
          <BackIcon />
        </Button>
      ) : null}
    </header>
  );
}

function BrandLogo() {
  return (
    <div className="brand" aria-label="Helix AI">
      <BrandMark />
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
