import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TreeEntry } from "../lib/tauri-api";
import { ConfirmDialog } from "./confirm-dialog";
import type { NoteId, NoteRecord, WorkspaceRecord } from "./types";

interface WorkspacePanelProps {
  readonly workspace: WorkspaceRecord;
  readonly onClose?: () => void;
  // Notes integration. The panel is the only surface that exposes the notes
  // list now — that's why these are required, not optional. The parent gates
  // panel visibility on `workspace.path`, so a missing path can't reach here.
  readonly notes: readonly NoteRecord[];
  readonly activeNoteId: NoteId | undefined;
  readonly notesLoading: boolean;
  readonly onSelectNote: (id: NoteId) => void;
  readonly onCreateNote: () => Promise<NoteRecord | undefined>;
  readonly onDeleteNote: (id: NoteId) => Promise<void> | void;
  /** Cmd/Ctrl+Shift+Click on a note row pops it into a detached window. */
  readonly onOpenNoteWindow: (note: NoteRecord) => void;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; entries: readonly TreeEntry[] }
  | { kind: "error"; message: string };

export function WorkspacePanel({
  workspace,
  onClose,
  notes,
  activeNoteId,
  notesLoading,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  onOpenNoteWindow,
}: WorkspacePanelProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  // Local expand/collapse state, keyed by folder path. Defaults to "open" for
  // the root level (depth 0) so the user sees something on first paint.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  // The note the user has asked to delete. While set, the confirm dialog
  // is open; null means no pending deletion.
  const [pendingDelete, setPendingDelete] = useState<NoteRecord | null>(null);

  const fetchTree = useCallback(async (path: string) => {
    try {
      const entries = await window.helixApi.listWorkspaceTree(path);
      return { ok: true as const, entries };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, message };
    }
  }, []);

  // Refetch the tree whenever the active workspace changes, install a fs
  // watcher for live updates, and tear both down on unmount / swap.
  useEffect(() => {
    if (!workspace.path) {
      setLoad({ kind: "ok", entries: [] });
      return;
    }

    let cancelled = false;
    setLoad({ kind: "loading" });
    setExpansion({});

    async function load(path: string) {
      const result = await fetchTree(path);
      if (cancelled) return;
      if (result.ok) setLoad({ kind: "ok", entries: result.entries });
      else setLoad({ kind: "error", message: result.message });
    }

    void load(workspace.path);

    // Install fs watcher and event listener. Multiple notify events can fire
    // for one user save (rename + write + chmod) — debounce 300ms on the
    // renderer so we refetch once per quiescent burst.
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const unlistenPromise = listen("workspace-tree-changed", () => {
      if (cancelled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (cancelled) return;
        void load(workspace.path);
      }, 300);
    });

    void window.helixApi.watchWorkspace(workspace.path).catch(() => {
      // Watcher failure shouldn't block the panel — the tree still loaded.
    });

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      void window.helixApi.unwatchWorkspace().catch(() => undefined);
      void unlistenPromise.then((un) => un()).catch(() => undefined);
    };
  }, [workspace.id, workspace.path, fetchTree]);

  // Filter to visible entries: skip anything under a collapsed folder.
  const visibleEntries = useMemo(() => {
    if (load.kind !== "ok") return [];
    const out: TreeEntry[] = [];
    let collapsedAtDepth = Number.POSITIVE_INFINITY;
    for (const entry of load.entries) {
      if (entry.depth > collapsedAtDepth) continue;
      collapsedAtDepth = Number.POSITIVE_INFINITY;
      out.push(entry);
      if (entry.kind === "folder") {
        // Default: depth 0 open, deeper folders closed.
        const openByDefault = entry.depth === 0;
        const isOpen = expansion[entry.path] ?? openByDefault;
        if (!isOpen) collapsedAtDepth = entry.depth;
      }
    }
    return out;
  }, [load, expansion]);

  function toggleFolder(path: string, depth: number) {
    setExpansion((prev) => ({
      ...prev,
      [path]: !(prev[path] ?? depth === 0),
    }));
  }

  function refresh() {
    if (!workspace.path) return;
    void (async () => {
      const result = await fetchTree(workspace.path);
      if (result.ok) setLoad({ kind: "ok", entries: result.entries });
      else setLoad({ kind: "error", message: result.message });
    })();
  }

  return (
    <aside className="panel">
      <div className="panel-header">
        <div className="panel-header-row">
          <span className="panel-label">Workspace</span>
          <span className="panel-header-spacer" />
          <button
            type="button"
            className="panel-icon-btn"
            onClick={() => void onCreateNote()}
            title="New note"
            aria-label="New note"
          >
            <NewNoteIcon />
          </button>
          <button
            type="button"
            className="panel-icon-btn"
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
          {onClose ? (
            <button
              type="button"
              className="panel-icon-btn"
              onClick={onClose}
              title="Hide files panel"
              aria-label="Hide files panel"
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
        <div className="panel-header-row">
          <span className="panel-crumb" title={workspace.path}>
            <FolderIcon />
            <span>{workspace.displayName}</span>
          </span>
        </div>
      </div>
      <div className="panel-scroll scroll">
        <PanelNotesSection
          notes={notes}
          activeId={activeNoteId}
          loading={notesLoading}
          onSelect={onSelectNote}
          onRequestDelete={(note) => setPendingDelete(note)}
          onOpenWindow={onOpenNoteWindow}
        />
        <div className="panel-section-label">
          <span>Files</span>
        </div>
        {load.kind === "loading" ? (
          <div className="panel-empty">Loading…</div>
        ) : load.kind === "error" ? (
          <div className="panel-empty panel-error">{load.message}</div>
        ) : load.kind === "ok" && load.entries.length === 0 ? (
          <div className="panel-empty">Empty folder.</div>
        ) : (
          visibleEntries.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              expanded={
                entry.kind === "folder"
                  ? (expansion[entry.path] ?? entry.depth === 0)
                  : false
              }
              onToggle={() => toggleFolder(entry.path, entry.depth)}
            />
          ))
        )}
      </div>
      {pendingDelete ? (
        <ConfirmDialog
          title={`Delete "${pendingDelete.title}"?`}
          description={`This removes ${pendingDelete.relativePath} from disk. This can't be undone.`}
          confirmLabel="Delete"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void onDeleteNote(target.id);
          }}
        />
      ) : null}
    </aside>
  );
}

interface PanelNotesSectionProps {
  readonly notes: readonly NoteRecord[];
  readonly activeId: NoteId | undefined;
  readonly loading: boolean;
  readonly onSelect: (id: NoteId) => void;
  /** Trash icon clicked. The panel decides what UI (confirm dialog) to show
   * before actually calling the destructive backend op. */
  readonly onRequestDelete: (note: NoteRecord) => void;
  readonly onOpenWindow: (note: NoteRecord) => void;
}

function PanelNotesSection({
  notes,
  activeId,
  loading,
  onSelect,
  onRequestDelete,
  onOpenWindow,
}: PanelNotesSectionProps) {
  return (
    <div className="panel-notes">
      <div className="panel-section-label">
        <span>Notes</span>
        <span className="panel-section-count">
          {loading && notes.length === 0 ? "scanning…" : notes.length}
        </span>
      </div>
      {notes.length === 0 ? (
        <div className="panel-empty">
          {loading ? "Scanning workspace…" : "No markdown files yet."}
        </div>
      ) : (
        notes.map((n) => (
          <NoteRow
            key={n.id}
            note={n}
            active={n.id === activeId}
            onSelect={() => onSelect(n.id)}
            onOpenWindow={() => onOpenWindow(n)}
            onRequestDelete={() => onRequestDelete(n)}
          />
        ))
      )}
    </div>
  );
}

interface NoteRowProps {
  readonly note: NoteRecord;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onOpenWindow: () => void;
  readonly onRequestDelete: () => void;
}

function NoteRow({
  note,
  active,
  onSelect,
  onOpenWindow,
  onRequestDelete,
}: NoteRowProps) {
  return (
    <div
      className="note-row"
      role="button"
      tabIndex={0}
      data-active={active || undefined}
      title={`${note.relativePath} — ⌘⇧Click to open in a new window`}
      onClick={(e) => {
        // Cmd/Ctrl + Shift + Click pops the note out into its own Tauri
        // window. Plain click (or any other modifier) selects in-pane.
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          e.preventDefault();
          onOpenWindow();
          return;
        }
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
            onOpenWindow();
          } else {
            onSelect();
          }
        }
      }}
    >
      <span className="note-row-title">{note.title}</span>
      <span className="note-row-meta">{note.relativePath}</span>
      <button
        type="button"
        className="note-row-delete"
        aria-label="Delete note"
        onClick={(e) => {
          e.stopPropagation();
          onRequestDelete();
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}k`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}G`;
}

interface TreeRowProps {
  readonly entry: TreeEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function TreeRow({ entry, expanded, onToggle }: TreeRowProps) {
  const isFolder = entry.kind === "folder";
  const size = formatSize(entry.size);
  return (
    <button
      type="button"
      className="tree-row"
      data-kind={entry.kind}
      style={{ paddingLeft: 8 + entry.depth * 12 }}
      title={entry.path}
      onClick={isFolder ? onToggle : undefined}
    >
      <span className="tree-row-icon" aria-hidden>
        {isFolder ? (expanded ? <ChevronDownIcon /> : <ChevronRightIcon />) : (
          <FileIcon />
        )}
      </span>
      <span className="tree-row-name">{entry.name}</span>
      {size ? <span className="tree-row-meta">{size}</span> : null}
    </button>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function RefreshIcon() {
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
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function NewNoteIcon() {
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
      aria-hidden
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M18 2v6M15 5h6" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}
