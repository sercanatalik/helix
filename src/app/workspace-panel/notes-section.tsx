import { memo } from "react";
import type { NoteId, NoteRecord } from "../types";
import { TrashIcon } from "./icons";

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

export function PanelNotesSection({
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
            onSelect={onSelect}
            onOpenWindow={onOpenWindow}
            onRequestDelete={onRequestDelete}
          />
        ))
      )}
    </div>
  );
}

interface NoteRowProps {
  readonly note: NoteRecord;
  readonly active: boolean;
  readonly onSelect: (id: NoteId) => void;
  readonly onOpenWindow: (note: NoteRecord) => void;
  readonly onRequestDelete: (note: NoteRecord) => void;
}

// memo so that swapping `activeId` (or any unrelated panel state) doesn't
// re-render every other note row in the list. The handler props are
// stable from the parent (useCallback'd), so default shallow compare hits.
const NoteRow = memo(function NoteRow({
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
          onOpenWindow(note);
          return;
        }
        onSelect(note.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
            onOpenWindow(note);
          } else {
            onSelect(note.id);
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
          onRequestDelete(note);
        }}
      >
        <TrashIcon />
      </button>
    </div>
  );
});
