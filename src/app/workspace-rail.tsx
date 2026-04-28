import type { AppView, WorkspaceId, WorkspaceRecord } from "./types";

interface WorkspaceRailProps {
  readonly activeView: AppView;
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  readonly onOpenSettings: () => void;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly activeWorkspaceId: WorkspaceId | undefined;
  readonly onSelectWorkspace: (id: WorkspaceId) => void;
  readonly onAddWorkspace: () => void;
  readonly onRemoveWorkspace: (id: WorkspaceId) => void;
  /** Whether the right-side files panel toggle is meaningful (i.e. the
   * active workspace has a folder attached). */
  readonly canTogglePanel: boolean;
  readonly panelOpen: boolean;
  readonly onTogglePanel: () => void;
}

export function WorkspaceRail({
  activeView,
  collapsed,
  onToggleCollapse,
  onOpenSettings,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRemoveWorkspace: _onRemoveWorkspace,
  canTogglePanel,
  panelOpen,
  onTogglePanel,
}: WorkspaceRailProps) {
  return (
    <aside className="rail">
      <div className="rail-drag" />

      {workspaces.map((ws) => (
        <button
          key={ws.id}
          type="button"
          className="rail-btn"
          data-active={
            activeView === "chat" && ws.id === activeWorkspaceId
          }
          title={ws.displayName}
          aria-label={`Workspace ${ws.displayName}`}
          onClick={() => onSelectWorkspace(ws.id)}
        >
          {initialsOf(ws.displayName)}
          <span className="rail-tooltip">{ws.displayName}</span>
        </button>
      ))}

      <button
        type="button"
        className="rail-btn rail-btn-icon"
        title="Add workspace"
        aria-label="Add workspace"
        onClick={onAddWorkspace}
      >
        <PlusIcon />
        <span className="rail-tooltip">Add workspace</span>
      </button>

      <div className="rail-spacer" />

      <button
        type="button"
        className="rail-btn rail-btn-icon"
        onClick={onToggleCollapse}
        title={collapsed ? "Show sidebar — ⌘B" : "Hide sidebar — ⌘B"}
        aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      >
        <PanelLeftIcon />
        <span className="rail-tooltip">
          {collapsed ? "Show sidebar" : "Hide sidebar"}
          <span style={{ opacity: 0.5, marginLeft: 6 }}>⌘B</span>
        </span>
      </button>

      {canTogglePanel ? (
        <button
          type="button"
          className="rail-btn rail-btn-icon"
          data-active={panelOpen}
          onClick={onTogglePanel}
          title={panelOpen ? "Hide files panel" : "Show files panel"}
          aria-label={panelOpen ? "Hide files panel" : "Show files panel"}
        >
          <PanelRightIcon />
          <span className="rail-tooltip">
            {panelOpen ? "Hide files" : "Show files"}
          </span>
        </button>
      ) : null}

      <button
        type="button"
        className="rail-btn rail-btn-icon"
        data-active={activeView === "settings"}
        onClick={onOpenSettings}
        title="Settings — ⌘,"
        aria-label="Settings"
      >
        <CogIcon />
        <span className="rail-tooltip">
          Settings<span style={{ opacity: 0.5, marginLeft: 6 }}>⌘,</span>
        </span>
      </button>
    </aside>
  );
}

/** First letters of the first two words of the display name, uppercased.
 * Falls back to the first two characters when there's only one word. */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "??";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

// Tiny inline SVG icons — no lucide-react dependency in the scaffold.
function PlusIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PanelLeftIcon() {
  return (
    <svg
      width="15"
      height="15"
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
function PanelRightIcon() {
  return (
    <svg
      width="15"
      height="15"
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
function CogIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01A1.65 1.65 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
