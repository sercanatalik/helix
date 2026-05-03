import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
  /** File row clicked. The parent reads the file via the `read_file` Tauri
   * command and pushes its content into the chat composer's pending context.
   * Folders are still handled internally by the panel (toggle expansion). */
  readonly onSelectFile?: (entry: TreeEntry) => void;
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
  onSelectFile,
}: WorkspacePanelProps) {
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
  // Inline edit state: VSCode-style rename of an existing entry, or
  // "new file"/"new folder" prompt that renders an input row inside the
  // tree (in place of, or as a child of, the target). Null when no edit
  // is in flight. The input itself owns the in-progress text; this state
  // only flags *what* is being edited and where.
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

  /** Reveal the right-clicked entry (or its parent for folders) in the OS
   * file manager. Folders open themselves; files get selected on macOS /
   * Windows where the underlying API supports it. */
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

  /** Push a file into chat context (same path as left-clicking the row).
   * Defensive against an accidental folder target — the menu hides this
   * action for folders, but a future caller might not. */
  const handleAddToContext = useCallback(
    (entry: TreeEntry) => {
      if (entry.kind !== "file") return;
      onSelectFile?.(entry);
    },
    [onSelectFile],
  );

  /** Create a new `untitled-N.md` under the right-clicked folder, or
   * under the workspace root when the user invoked the menu on the
   * background. The watcher-driven rescan picks the file up; we also
   * surface a brief notice so the action feels confirmed even on a
   * crowded tree. */
  const handleNewMarkdown = useCallback(
    async (parentDir: string) => {
      if (!workspace.path) return;
      try {
        const note = await window.helixApi.createMarkdownFile(
          workspace.id,
          workspace.path,
          parentDir,
        );
        setNotice({
          tone: "info",
          message: `Created ${note.relativePath}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `New file failed: ${message}` });
      }
    },
    [workspace.id, workspace.path],
  );

  /** Confirm-then-delete an entry. Handles both files and folders via
   * `delete_workspace_path` (recursive for directories). The note-list
   * deletion still routes through `onDeleteNote` for markdown files
   * tracked by the notes scanner — that path also rebuilds the notes
   * list — but this branch covers the broader tree. */
  const handleConfirmFileDelete = useCallback(
    async (entry: TreeEntry) => {
      if (!workspace.path) return;
      try {
        await window.helixApi.deleteWorkspacePath(
          workspace.path,
          entry.path,
        );
        const label = entry.kind === "folder" ? "folder" : "file";
        setNotice({
          tone: "info",
          message: `Deleted ${label} ${entry.name}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", message: `Delete failed: ${message}` });
      }
    },
    [workspace.path],
  );

  // ---- Inline edit handlers --------------------------------------------

  /** Begin renaming `entry`. Opens an input row in place of the existing
   * row, pre-filled with the current name. */
  const beginRename = useCallback((entry: TreeEntry) => {
    setEdit({ kind: "rename", entry });
  }, []);

  /** Begin a "new file" or "new folder" inline edit. The input row
   * renders inside `parentDir` — at depth `parentDepth + 1` if the user
   * right-clicked a folder, or at depth 0 when invoked on the empty
   * background (anchored to the workspace root).
   *
   * Auto-expands the parent folder so the input is visible without
   * requiring a separate click. */
  const beginNew = useCallback(
    (
      parentDir: string,
      parentDepth: number,
      entryKind: "file" | "folder",
    ) => {
      // If the parent is a real folder row (not the workspace root), make
      // sure it's expanded so the new-row input is visible underneath.
      setExpansion((prev) => {
        if (parentDir === workspace.path) return prev;
        if (prev[parentDir] === true) return prev;
        return { ...prev, [parentDir]: true };
      });
      setEdit({ kind: "new", parentDir, parentDepth, entryKind });
    },
    [workspace.path],
  );

  /** Cancel any in-flight edit. Bound to Escape and onBlur in the
   * EditRow input. Idempotent. */
  const cancelEdit = useCallback(() => setEdit(null), []);

  /** Commit a rename. Drops the edit on success or surfaces the error in
   * the panel notice; the watcher-driven rescan picks the new name up.
   * Empty / unchanged names short-circuit to a plain cancel so the user
   * can hit Enter on an unchanged input without an error. */
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

  /** Commit a "new file"/"new folder". Same pattern as rename — show a
   * notice on failure, drop the edit on success. */
  const commitNew = useCallback(
    async (
      parentDir: string,
      name: string,
      entryKind: "file" | "folder",
    ) => {
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
        setNotice({
          tone: "error",
          message: `Create failed: ${message}`,
        });
        setEdit(null);
      }
    },
    [workspace.path],
  );

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
      <div
        className="panel-scroll scroll"
        // Right-click on the empty area of the scroll container opens the
        // background menu (workspace-root scoped: only "New markdown file"
        // makes sense). Rows handle their own contextmenu and stop
        // propagation so they don't bubble up to this generic handler.
        onContextMenu={(e) => openMenu(e, null)}
      >
        {notice ? (
          <div
            className="panel-empty"
            data-tone={notice.tone}
            role="status"
          >
            {notice.message}
          </div>
        ) : null}
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
                        void commitNew(
                          edit.parentDir,
                          value,
                          edit.entryKind,
                        )
                      }
                      onCancel={cancelEdit}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </>
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
          onRequestDelete={(entry) => setPendingFileDelete(entry)}
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

interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  /** The row the menu was opened on; null for empty-area / background. */
  readonly target: TreeEntry | null;
}

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

interface TreeEditRowProps {
  readonly depth: number;
  readonly kind: "file" | "folder";
  readonly initialValue: string;
  /** When true (rename of a file with an extension), pre-select only the
   * stem so the user can overwrite the name without losing the suffix.
   * Folders and new entries select the entire input. */
  readonly selectStem?: boolean;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}

/** Inline input row used for rename and new-file / new-folder. Mirrors
 * `TreeRow`'s grid so the input lines up with the surrounding tree. The
 * input owns its draft text — committing fires `onCommit` with the
 * trimmed value; Escape and onBlur both cancel. */
function TreeEditRow({
  depth,
  kind,
  initialValue,
  selectStem = false,
  onCommit,
  onCancel,
}: TreeEditRowProps) {
  const [value, setValue] = useState(initialValue);
  // Track whether we've already committed/cancelled so onBlur after a
  // programmatic Enter doesn't fire the cancel path a second time. (Some
  // browsers blur the input as part of dispatching Enter when the row is
  // re-rendered out of the tree.)
  const settledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    if (selectStem && initialValue.includes(".")) {
      const idx = initialValue.lastIndexOf(".");
      // Guard against leading-dot files like `.gitignore` — selecting
      // length 0 would be a no-op anyway, but prefer "select all" there.
      if (idx > 0) node.setSelectionRange(0, idx);
      else node.select();
    } else {
      node.select();
    }
  }, [initialValue, selectStem]);

  function commit() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  }
  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }

  return (
    <div
      className="tree-row tree-row-edit"
      data-kind={kind}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="tree-row-icon" aria-hidden>
        {kind === "folder" ? <FolderIcon /> : <FileIcon />}
      </span>
      <input
        ref={inputRef}
        className="tree-row-edit-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={cancel}
      />
    </div>
  );
}

interface ContextMenuProps {
  readonly state: ContextMenuState;
  readonly workspaceRoot: string;
  readonly onClose: () => void;
  readonly onAddToContext: (entry: TreeEntry) => void;
  readonly onReveal: (entry: TreeEntry) => void;
  readonly onNewMarkdown: (parentDir: string) => void;
  readonly onRequestDelete: (entry: TreeEntry) => void;
  /** Begin a VSCode-style inline rename of the target row. */
  readonly onBeginRename: (entry: TreeEntry) => void;
  /** Begin a VSCode-style inline "new file" / "new folder" entry inside
   * `parentDir`. `parentDepth` is the visual depth of the parent in the
   * tree (used by the inline input row to indent itself one level
   * deeper); pass `-1` for the workspace root. */
  readonly onBeginNew: (
    parentDir: string,
    parentDepth: number,
    kind: "file" | "folder",
  ) => void;
}

/** Lightweight portal-less context menu. Rendered into the panel's normal
 * tree but positioned `fixed` to the viewport. Closes on outside mousedown,
 * Escape, or window resize/scroll — anywhere it might end up visually
 * detached from the cursor. */
function ContextMenu({
  state,
  workspaceRoot,
  onClose,
  onAddToContext,
  onReveal,
  onNewMarkdown,
  onRequestDelete,
  onBeginRename,
  onBeginNew,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Pre-compute geometry: clamp into the viewport so a right-click in the
  // bottom-right corner still shows a fully-visible menu.
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
    // Capture-phase scroll catches nested scroll containers (the
    // `.panel-scroll` div) too; the menu is anchored to viewport coords
    // and would otherwise drift away from the row that spawned it.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const target = state.target;
  const isFolder = target?.kind === "folder";
  const isFile = target?.kind === "file";
  const newMdParent = isFolder
    ? target.path
    : isFile
      ? parentOf(target.path)
      : workspaceRoot;

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      // Right-clicking the menu itself shouldn't open another menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {isFile && target ? (
        <>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onAddToContext(target);
              onClose();
            }}
          >
            Add to chat context
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onReveal(target);
              onClose();
            }}
          >
            Reveal in folder
          </button>
          <div className="ctx-menu-sep" role="separator" />
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginRename(target);
              onClose();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            data-tone="danger"
            onClick={() => {
              onRequestDelete(target);
              onClose();
            }}
          >
            Delete…
          </button>
        </>
      ) : isFolder && target ? (
        <>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginNew(target.path, target.depth, "file");
              onClose();
            }}
          >
            New file…
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginNew(target.path, target.depth, "folder");
              onClose();
            }}
          >
            New folder…
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onNewMarkdown(target.path);
              onClose();
            }}
          >
            New markdown file (quick)
          </button>
          <div className="ctx-menu-sep" role="separator" />
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onReveal(target);
              onClose();
            }}
          >
            Reveal in folder
          </button>
          <div className="ctx-menu-sep" role="separator" />
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginRename(target);
              onClose();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            data-tone="danger"
            onClick={() => {
              onRequestDelete(target);
              onClose();
            }}
          >
            Delete folder…
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginNew(workspaceRoot, -1, "file");
              onClose();
            }}
          >
            New file…
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onBeginNew(workspaceRoot, -1, "folder");
              onClose();
            }}
          >
            New folder…
          </button>
          <button
            type="button"
            className="ctx-menu-item"
            role="menuitem"
            onClick={() => {
              onNewMarkdown(newMdParent);
              onClose();
            }}
          >
            New markdown file (quick)
          </button>
        </>
      )}
    </div>
  );
}

/** Trim the trailing path segment. Cross-platform — works on POSIX and
 * Windows paths because we look for either separator. */
function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return path;
  return path.slice(0, idx);
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
  /** Click on a file row. Folders ignore this and run `onToggle` instead. */
  readonly onSelectFile?: (entry: TreeEntry) => void;
  /** Right-click on a row. Files surface "add to context / reveal / delete";
   * folders surface "new markdown file / reveal". */
  readonly onContextMenu?: (e: ReactMouseEvent, entry: TreeEntry) => void;
}

function TreeRow({
  entry,
  expanded,
  onToggle,
  onSelectFile,
  onContextMenu,
}: TreeRowProps) {
  const isFolder = entry.kind === "folder";
  const size = formatSize(entry.size);
  // Files: clicking attaches the file as chat context (parent owns the
  // read + dispatch). When no handler is wired the row is a no-op, matching
  // the prior behaviour so older callers don't suddenly see clicks fire.
  const onClick = isFolder
    ? onToggle
    : onSelectFile
      ? () => onSelectFile(entry)
      : undefined;
  const fileTitle = !isFolder
    ? `${entry.path}\nClick to attach this file as context for the next message.\nRight-click for more.`
    : `${entry.path}\nRight-click for actions.`;
  return (
    <button
      type="button"
      className="tree-row"
      data-kind={entry.kind}
      style={{ paddingLeft: 8 + entry.depth * 12 }}
      title={fileTitle}
      onClick={onClick}
      onContextMenu={
        onContextMenu ? (e) => onContextMenu(e, entry) : undefined
      }
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
