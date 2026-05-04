import type { ReactNode } from "react";
import { BrandMark } from "./brand-mark";
import { Button } from "../components/ui";

interface TitlebarProps {
  /** Variant determines what fills the titlebar's flexible middle slot. */
  readonly variant?: "session" | "settings";
  /** Session crumb — only meaningful when variant is "session". */
  readonly sessionTitle?: string;
  readonly sessionSkill?: string;
  readonly sessionStartedAt?: string;
  /** Settings caption — only meaningful when variant is "settings". */
  readonly title?: string;
  readonly onBack?: () => void;
  /** Trailing controls. Rendered as part of the titlebar so the brand,
   * the session crumb, and the toggles share one chrome strip. */
  readonly sidebarOpen?: boolean;
  readonly onToggleSidebar?: () => void;
  readonly canTogglePanel?: boolean;
  readonly panelOpen?: boolean;
  readonly onTogglePanel?: () => void;
  /** Slot for view-specific actions (branch, share). Falls into the controls
   * section to the right of the panel toggle, separated by a divider. */
  readonly actions?: ReactNode;
}

export function Titlebar({
  variant = "session",
  sessionTitle,
  sessionSkill,
  sessionStartedAt,
  title,
  onBack,
  sidebarOpen,
  onToggleSidebar,
  canTogglePanel,
  panelOpen,
  onTogglePanel,
  actions,
}: TitlebarProps) {
  const isSettings = variant === "settings";
  return (
    <header className="titlebar">
      <BrandLogo />
      <div className="titlebar-divider" aria-hidden />
      {isSettings ? (
        <div className="titlebar-settings">
          {onBack ? (
            <Button
              variant="icon"
              size="icon"
              onClick={onBack}
              title="Back to chat"
              aria-label="Back to chat"
              className="titlebar-back"
            >
              <BackIcon />
            </Button>
          ) : null}
          <span className="titlebar-title">{title ?? "Settings"}</span>
        </div>
      ) : (
        <SessionCrumb
          title={sessionTitle}
          skill={sessionSkill}
          startedAt={sessionStartedAt}
        />
      )}
      <div className="titlebar-controls">
        {onToggleSidebar ? (
          <button
            type="button"
            className="titlebar-icon-btn"
            data-active={sidebarOpen ? "true" : undefined}
            onClick={onToggleSidebar}
            title={sidebarOpen ? "Hide sidebar — ⌘B" : "Show sidebar — ⌘B"}
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-pressed={sidebarOpen}
          >
            <SidebarLeftIcon />
          </button>
        ) : null}
        {onTogglePanel ? (
          <button
            type="button"
            className="titlebar-icon-btn"
            data-active={panelOpen ? "true" : undefined}
            data-empty={!canTogglePanel ? "true" : undefined}
            onClick={onTogglePanel}
            disabled={!canTogglePanel}
            title={
              !canTogglePanel
                ? "Workspace pane — attach a folder first"
                : panelOpen
                  ? "Hide workspace — ⌘⌥B"
                  : "Show workspace — ⌘⌥B"
            }
            aria-label={panelOpen ? "Hide workspace" : "Show workspace"}
            aria-pressed={panelOpen}
          >
            <SidebarRightIcon />
          </button>
        ) : null}
        {actions ? (
          <>
            <div className="titlebar-divider" aria-hidden />
            {actions}
          </>
        ) : null}
      </div>
    </header>
  );
}

function BrandLogo() {
  return (
    <div className="brand" aria-label="Helix by GCF">
      <BrandMark size={20} />
      <span className="brand-text">
        <span className="brand-title">Helix</span>
        <span className="brand-sub-name">by GCF</span>
      </span>
    </div>
  );
}

interface SessionCrumbProps {
  readonly title?: string;
  readonly skill?: string;
  readonly startedAt?: string;
}

function SessionCrumb({ title, skill, startedAt }: SessionCrumbProps) {
  if (!title && !skill && !startedAt) {
    return <div className="session-crumb session-crumb-empty" />;
  }
  return (
    <div className="session-crumb" title={title}>
      {title ? <span className="session-crumb-title">{title}</span> : null}
      {skill ? (
        <span className="session-crumb-skill">/{stripLeadingSlash(skill)}</span>
      ) : null}
      {startedAt ? (
        <span className="session-crumb-time">· {formatStartedAt(startedAt)}</span>
      ) : null}
    </div>
  );
}

function stripLeadingSlash(text: string): string {
  return text.startsWith("/") ? text.slice(1) : text;
}

function formatStartedAt(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function SidebarLeftIcon() {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function SidebarRightIcon() {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}
