import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import type { TreeEntry } from "../../lib/tauri-api";
import { ConfirmDialog } from "../confirm-dialog";
import type { NoteId, NoteRecord, WorkspaceRecord } from "../types";
import { ContextMenu, type ContextMenuState } from "./context-menu";
import { NewNoteIcon, RefreshIcon } from "./icons";
import { PanelNotesSection } from "./notes-section";
import { TreeEditRow, TreeRow } from "./tree-row";

interface WorkspacePanelProps {
  readonly workspace: WorkspaceRecord;
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
  /** File row clicked. The parent reads the file via the `read_file` Tauri
   * command and pushes its content into the chat composer's pending context.
   * Folders are still handled internally by the panel (toggle expansion). */
  readonly onSelectFile?: (entry: TreeEntry) => void;
}

type PanelTab = "files" | "notes";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; entries: readonly TreeEntry[] }
  | { kind: "error"; message: string };

/** Inline-edit mode for the tree. `rename` swaps an existing row for an
 * input pre-filled with its name; `new` injects a fresh input row inside
 * `parentDir` to capture the name of a newly-created file or folder. */
type EditState =
  | { readonly kind: "rename"; readonly entry: TreeEntry }
  | {
      readonly kind: "new";
      readonly parentDir: string;
      readonly parentDepth: number;
      readonly entryKind: "file" | "folder";
    };

export function WorkspacePanel({
  workspace,
  notes,
  activeNoteId,
  notesLoading,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  onOpenNoteWindow,
  onSelectFile,
}: WorkspacePanelProps) {
  const [tab, setTab] = useState<PanelTab>("files");
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  // Local expand/collapse state, keyed by folder path. Defaults to "open" for
  // the root level (depth 0) so the user sees something on first paint.
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  // The note the user has asked to delete. While set, the confirm dialog
  // is open; null means no pending deletion.
  const [pendingDelete, setPendingDelete] = useState<NoteRecord | null>(null);
  // Right-click context menu state. `target` carries the file/folder the
  // user invoked the menu on (or null for the empty-area / panel-bg menu),
  // plus screen coordinates so the menu can render at the cursor.
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // File-level destructive delete (from the right-click menu). Distinct
  // from `pendingDelete` (which is note-level) because the file path may
  // not appear in the notes list at all — markdown rendering rules apply
  // there but not here.
  const [pendingFileDelete, setPendingFileDelete] =
    useState<TreeEntry | null>(null);
  // One-shot status banner for context-menu actions (reveal, delete,
  // new file). Self-clears after a few seconds.
  const [notice, setNotice] = useState<
    { tone: "info" | "error"; message: string } | null
  >(null);
  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(handle);
  }, [notice]);
  // Inline edit state. Null when no edit is in flight; the input itself
  // owns the in-progress text — this state only flags *what* is being
  // edited and where.
  const [edit, setEdit] = useState<EditState | null>(null);

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

  // ---- Right-click context menu handlers --------------------------------

  /** Open the menu anchored to the cursor. `target` is the row the user
   * right-clicked on, or null when they right-clicked the panel background
   * / files section. The component clamps to the viewport on render. */
  function openMenu(e: ReactMouseEvent, target: TreeEntry | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleReveal = useCallback(
    async (entry: TreeEntry) => {
      try {
        await window.helixApi.revealInFolder(entry.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `Reveal failed: ${message}` });
      }
    },
    [],
  );

  const handleAddToContext = useCallback(
    (entry: TreeEntry) => {
      if (entry.kind !== "file") return;
      onSelectFile?.(entry);
    },
    [onSelectFile],
  );

  const handleNewMarkdown = useCallback(
    async (parentDir: string) => {
      if (!workspace.path) return;
      try {
        const note = await window.helixApi.createMarkdownFile(
          workspace.id,
          workspace.path,
          parentDir,
        );
        setNotice({ tone: "info", message: `Created ${note.relativePath}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `New file failed: ${message}` });
      }
    },
    [workspace.id, workspace.path],
  );

  const handleConfirmFileDelete = useCallback(
    async (entry: TreeEntry) => {
      if (!workspace.path) return;
      try {
        await window.helixApi.deleteWorkspacePath(workspace.path, entry.path);
        const label = entry.kind === "folder" ? "folder" : "file";
        setNotice({ tone: "info", message: `Deleted ${label} ${entry.name}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `Delete failed: ${message}` });
      }
    },
    [workspace.path],
  );

  // ---- Inline edit handlers --------------------------------------------

  const beginRename = useCallback((entry: TreeEntry) => {
    setEdit({ kind: "rename", entry });
  }, []);

  /** Begin a "new file" or "new folder" inline edit. Auto-expands the
   * parent folder so the input row is visible without a second click. */
  const beginNew = useCallback(
    (parentDir: string, parentDepth: number, entryKind: "file" | "folder") => {
      setExpansion((prev) => {
        if (parentDir === workspace.path) return prev;
        if (prev[parentDir] === true) return prev;
        return { ...prev, [parentDir]: true };
      });
      setEdit({ kind: "new", parentDir, parentDepth, entryKind });
    },
    [workspace.path],
  );

  const cancelEdit = useCallback(() => setEdit(null), []);

  const commitRename = useCallback(
    async (entry: TreeEntry, nextName: string) => {
      if (!workspace.path) {
        setEdit(null);
        return;
      }
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === entry.name) {
        setEdit(null);
        return;
      }
      try {
        await window.helixApi.renameWorkspacePath(
          workspace.path,
          entry.path,
          trimmed,
        );
        setEdit(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `Rename failed: ${message}` });
        setEdit(null);
      }
    },
    [workspace.path],
  );

  const commitNew = useCallback(
    async (parentDir: string, name: string, entryKind: "file" | "folder") => {
      if (!workspace.path) {
        setEdit(null);
        return;
      }
      const trimmed = name.trim();
      if (!trimmed) {
        setEdit(null);
        return;
      }
      try {
        await window.helixApi.createWorkspaceEntry(
          workspace.path,
          parentDir,
          trimmed,
          entryKind,
        );
        setEdit(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `Create failed: ${message}` });
        setEdit(null);
      }
    },
    [workspace.path],
  );

  const fileCount =
    load.kind === "ok"
      ? load.entries.filter((e) => e.kind === "file").length
      : undefined;
  const watcherActive = load.kind === "ok" && !!workspace.path;

  return (
    <aside className="panel">
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Workspace pane">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className="panel-tab"
            data-active={tab === "files" || undefined}
            onClick={() => setTab("files")}
          >
            Files
            {fileCount !== undefined ? (
              <span className="panel-tab-count">{fileCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "notes"}
            className="panel-tab"
            data-active={tab === "notes" || undefined}
            onClick={() => setTab("notes")}
          >
            Notes
            <span className="panel-tab-count">{notes.length}</span>
          </button>
          <span className="panel-header-spacer" />
          {tab === "notes" ? (
            <button
              type="button"
              className="panel-icon-btn"
              onClick={() => void onCreateNote()}
              title="New note"
              aria-label="New note"
            >
              <NewNoteIcon />
            </button>
          ) : null}
          <button
            type="button"
            className="panel-icon-btn"
            onClick={refresh}
            title="Refresh — re-scan the workspace folder"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <div
        className="panel-scroll scroll"
        // Right-click on the empty area of the scroll container opens the
        // background menu (workspace-root scoped: only "New markdown file"
        // makes sense). Rows handle their own contextmenu and stop
        // propagation so they don't bubble up to this generic handler.
        onContextMenu={(e) => openMenu(e, null)}
      >
        {notice ? (
          <div className="panel-empty" data-tone={notice.tone} role="status">
            {notice.message}
          </div>
        ) : null}
        {tab === "notes" ? (
          <PanelNotesSection
            notes={notes}
            activeId={activeNoteId}
            loading={notesLoading}
            onSelect={onSelectNote}
            onRequestDelete={setPendingDelete}
            onOpenWindow={onOpenNoteWindow}
          />
        ) : null}
        {tab === "files" ? (
          load.kind === "loading" ? (
            <div className="panel-empty">Loading…</div>
          ) : load.kind === "error" ? (
            <div className="panel-empty panel-error">{load.message}</div>
          ) : load.kind === "ok" && load.entries.length === 0 ? (
            <div className="panel-empty">Empty folder.</div>
          ) : (
            <>
              {/* When the user invoked "New file/folder" from the panel
                  background, the input row anchors to the workspace root and
                  renders before everything else. Same shape as the in-tree
                  variant — only the depth differs. */}
              {edit?.kind === "new" && edit.parentDir === workspace.path ? (
                <TreeEditRow
                  key="__new-root__"
                  depth={0}
                  kind={edit.entryKind === "folder" ? "folder" : "file"}
                  initialValue=""
                  onCommit={(value) =>
                    void commitNew(edit.parentDir, value, edit.entryKind)
                  }
                  onCancel={cancelEdit}
                />
              ) : null}
              {visibleEntries.map((entry) => {
                const isRenaming =
                  edit?.kind === "rename" && edit.entry.path === entry.path;
                const newChildHere =
                  edit?.kind === "new" &&
                  entry.kind === "folder" &&
                  edit.parentDir === entry.path;
                return (
                  <Fragment key={entry.path}>
                    {isRenaming && edit ? (
                      <TreeEditRow
                        depth={entry.depth}
                        kind={entry.kind}
                        initialValue={entry.name}
                        selectStem={entry.kind === "file"}
                        onCommit={(value) => void commitRename(entry, value)}
                        onCancel={cancelEdit}
                      />
                    ) : (
                      <TreeRow
                        entry={entry}
                        expanded={
                          entry.kind === "folder"
                            ? (expansion[entry.path] ?? entry.depth === 0)
                            : false
                        }
                        onToggle={() => toggleFolder(entry.path, entry.depth)}
                        onSelectFile={onSelectFile}
                        onContextMenu={(e) => openMenu(e, entry)}
                      />
                    )}
                    {newChildHere && edit ? (
                      <TreeEditRow
                        depth={entry.depth + 1}
                        kind={edit.entryKind === "folder" ? "folder" : "file"}
                        initialValue=""
                        onCommit={(value) =>
                          void commitNew(edit.parentDir, value, edit.entryKind)
                        }
                        onCancel={cancelEdit}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </>
          )
        ) : null}
      </div>
      <div className="panel-footer">
        <span
          className="panel-footer-dot"
          data-active={watcherActive || undefined}
          aria-hidden
        />
        {tab === "files" ? (
          <span className="panel-footer-text">
            {fileCount === undefined
              ? "scanning…"
              : `${fileCount} ${fileCount === 1 ? "file" : "files"}`}
            {watcherActive ? " · watching" : ""}
          </span>
        ) : (
          <span className="panel-footer-text">
            {notesLoading
              ? "scanning…"
              : `${notes.length} ${notes.length === 1 ? "note" : "notes"}`}
            {watcherActive ? " · watching" : ""}
          </span>
        )}
      </div>
      {menu ? (
        <ContextMenu
          state={menu}
          workspaceRoot={workspace.path}
          onClose={closeMenu}
          onAddToContext={handleAddToContext}
          onReveal={(entry) => void handleReveal(entry)}
          onNewMarkdown={(parentDir) => void handleNewMarkdown(parentDir)}
          onRequestDelete={setPendingFileDelete}
          onBeginRename={beginRename}
          onBeginNew={beginNew}
        />
      ) : null}
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
      {pendingFileDelete ? (
        <ConfirmDialog
          title={
            pendingFileDelete.kind === "folder"
              ? `Delete folder "${pendingFileDelete.name}"?`
              : `Delete "${pendingFileDelete.name}"?`
          }
          description={
            pendingFileDelete.kind === "folder"
              ? `This removes ${pendingFileDelete.path} and everything inside it. This can't be undone.`
              : `This removes ${pendingFileDelete.path} from disk. This can't be undone.`
          }
          confirmLabel="Delete"
          destructive
          onCancel={() => setPendingFileDelete(null)}
          onConfirm={() => {
            const target = pendingFileDelete;
            setPendingFileDelete(null);
            void handleConfirmFileDelete(target);
          }}
        />
      ) : null}
    </aside>
  );
}
