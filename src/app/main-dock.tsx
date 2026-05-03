import type { MouseEvent } from "react";
import type { NoteId, NoteRecord } from "./types";

interface MainDockProps {
  /** Subtitle shown next to the Chat tab — e.g. workspace name or session
   * title. Optional; when omitted only "Chat" renders. */
  readonly chatSubtitle?: string;
  /** Open note tabs in display order. Already filtered to records that
   * still exist on disk — the dock just renders. */
  readonly openNotes: readonly NoteRecord[];
  /** Active tab id. Either the literal string "chat" or a NoteId. */
  readonly activeId: "chat" | NoteId;
  readonly onSelectChat: () => void;
  readonly onSelectNote: (id: NoteId) => void;
  readonly onCloseNote: (id: NoteId) => void;
  /** Pop the note out into its own Tauri window. The dock closes the tab
   * here so the same file isn't open in two windows at once. */
  readonly onDetachNote: (note: NoteRecord) => void;
}

/** VSCode-style tab strip across the top of the main pane. Chat is always
 * the first, pinned tab; everything else is an opened markdown file. */
export function MainDock({
  chatSubtitle,
  openNotes,
  activeId,
  onSelectChat,
  onSelectNote,
  onCloseNote,
  onDetachNote,
}: MainDockProps) {
  return (
    <header className="main-dock" role="tablist" aria-label="Open documents">
      <ChatTab
        active={activeId === "chat"}
        subtitle={chatSubtitle}
        onSelect={onSelectChat}
      />
      {openNotes.map((note) => (
        <NoteTab
          key={note.id}
          note={note}
          active={activeId === note.id}
          onSelect={() => onSelectNote(note.id)}
          onClose={() => onCloseNote(note.id)}
          onDetach={() => onDetachNote(note)}
        />
      ))}
      <div className="dock-spacer" />
    </header>
  );
}

interface ChatTabProps {
  readonly active: boolean;
  readonly subtitle?: string;
  readonly onSelect: () => void;
}

function ChatTab({ active, subtitle, onSelect }: ChatTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="dock-tab dock-tab-pinned"
      data-active={active || undefined}
      title={subtitle ? `Chat — ${subtitle}` : "Chat"}
      onClick={onSelect}
    >
      <span className="dock-tab-icon" aria-hidden>
        <ChatIcon />
      </span>
      <span className="dock-tab-label">Chat</span>
      {subtitle ? <span className="dock-tab-subtle">{subtitle}</span> : null}
    </button>
  );
}

interface NoteTabProps {
  readonly note: NoteRecord;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
  readonly onDetach: () => void;
}

function NoteTab({ note, active, onSelect, onClose, onDetach }: NoteTabProps) {
  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    // Cmd/Ctrl + Shift + Click pops the note into its own window. Keeps the
    // muscle memory consistent with the panel row.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      onDetach();
      return;
    }
    onSelect();
  }

  function handleAuxClick(e: MouseEvent<HTMLButtonElement>) {
    // Middle-click closes — VSCode parity.
    if (e.button === 1) {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="dock-tab"
      data-active={active || undefined}
      title={`${note.relativePath} — ⌘⇧Click to detach`}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
    >
      <span className="dock-tab-icon" aria-hidden>
        <FileIcon />
      </span>
      <span className="dock-tab-label">{note.title}</span>
      <span
        role="button"
        tabIndex={-1}
        className="dock-tab-close"
        aria-label={`Close ${note.title}`}
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <CloseIcon />
      </span>
    </button>
  );
}

function ChatIcon() {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
