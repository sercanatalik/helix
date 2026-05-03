import { useEffect, useRef, useState } from "react";
import type { TreeEntry } from "../../lib/tauri-api";

export interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  /** The row the menu was opened on; null for empty-area / background. */
  readonly target: TreeEntry | null;
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
export function ContextMenu({
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
