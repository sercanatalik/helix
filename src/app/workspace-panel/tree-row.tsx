import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TreeEntry } from "../../lib/tauri-api";
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon } from "./icons";

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

export function TreeRow({
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
export function TreeEditRow({
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

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}k`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}G`;
}
