import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { AppView, WorkspaceId, WorkspaceRecord } from "./types";

interface WorkspaceRailProps {
  readonly activeView: AppView;
  readonly onOpenSettings: () => void;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly activeWorkspaceId: WorkspaceId | undefined;
  readonly onSelectWorkspace: (id: WorkspaceId) => void;
  readonly onAddWorkspace: () => void;
  readonly onRequestRename: (workspace: WorkspaceRecord) => void;
  /** Pop the OS folder picker for an existing workspace and update its path
   * with the chosen folder. Implemented in the parent so the rail stays
   * dialog-agnostic. */
  readonly onRequestChangeFolder: (workspace: WorkspaceRecord) => void;
  readonly onRequestDetachFolder: (workspace: WorkspaceRecord) => void;
  readonly onRequestDelete: (workspace: WorkspaceRecord) => void;
}

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly workspace: WorkspaceRecord;
}

export function WorkspaceRail({
  activeView,
  onOpenSettings,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onAddWorkspace,
  onRequestRename,
  onRequestChangeFolder,
  onRequestDetachFolder,
  onRequestDelete,
}: WorkspaceRailProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const canDelete = workspaces.length > 1;

  function openMenu(e: ReactMouseEvent, workspace: WorkspaceRecord) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, workspace });
  }

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
          onContextMenu={(e) => openMenu(e, ws)}
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
      {menu ? (
        <RailContextMenu
          state={menu}
          canDelete={canDelete}
          onClose={() => setMenu(null)}
          onRename={onRequestRename}
          onChangeFolder={onRequestChangeFolder}
          onDetachFolder={onRequestDetachFolder}
          onDelete={onRequestDelete}
        />
      ) : null}
    </aside>
  );
}

interface RailContextMenuProps {
  readonly state: MenuState;
  readonly canDelete: boolean;
  readonly onClose: () => void;
  readonly onRename: (workspace: WorkspaceRecord) => void;
  readonly onChangeFolder: (workspace: WorkspaceRecord) => void;
  readonly onDetachFolder: (workspace: WorkspaceRecord) => void;
  readonly onDelete: (workspace: WorkspaceRecord) => void;
}

function RailContextMenu({
  state,
  canDelete,
  onClose,
  onRename,
  onChangeFolder,
  onDetachFolder,
  onDelete,
}: RailContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 6;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setPos({
      x: Math.max(margin, Math.min(state.x, Math.max(margin, maxX))),
      y: Math.max(margin, Math.min(state.y, Math.max(margin, maxY))),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = ref.current;
      if (!node) return onClose();
      if (!node.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const ws = state.workspace;
  const hasPath = !!ws.path;

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="ctx-menu-item"
        role="menuitem"
        onClick={() => {
          onRename(ws);
          onClose();
        }}
      >
        Rename…
      </button>
      <button
        type="button"
        className="ctx-menu-item"
        role="menuitem"
        onClick={() => {
          onChangeFolder(ws);
          onClose();
        }}
      >
        {hasPath ? "Change folder…" : "Attach folder…"}
      </button>
      {hasPath ? (
        <button
          type="button"
          className="ctx-menu-item"
          role="menuitem"
          onClick={() => {
            onDetachFolder(ws);
            onClose();
          }}
        >
          Detach folder
        </button>
      ) : null}
      {canDelete ? (
        <>
          <div className="ctx-menu-sep" role="separator" />
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            data-tone="danger"
            onClick={() => {
              onDelete(ws);
              onClose();
            }}
          >
            Delete workspace…
          </button>
        </>
      ) : null}
    </div>
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
