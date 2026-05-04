import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { helixApi } from "../../lib/tauri-api";
import {
  loadEditorMode,
  saveEditorMode,
  type EditorMode,
} from "../../lib/notes/storage";
import type { NoteRecord, WorkspaceRecord } from "../../app/types";

// Each editor lives in its own chunk so opening a note pulls only the
// active mode. BlockNote (rich) drags in shiki + mantine + the prosemirror
// stack; CodeMirror (raw) drags in lang-markdown + lezer. Splitting saves
// ~600KB on the side the user isn't currently viewing.
const BlockNoteEditor = lazy(() =>
  import("./blocknote-editor").then((m) => ({ default: m.BlockNoteEditor })),
);
const CodeMirrorEditor = lazy(() =>
  import("./codemirror-editor").then((m) => ({ default: m.CodeMirrorEditor })),
);

const SAVE_DEBOUNCE_MS = 500;
const NOTE_CHANGED_EVENT = "helix://note-changed";

interface NoteEditorContainerProps {
  readonly workspace: WorkspaceRecord;
  readonly note: NoteRecord;
  /** Fires when the H1 changes and the file gets renamed off `untitled-N.md`.
   * Parent should swap its `activeNoteId` to keep the new file selected. */
  readonly onRenamed: (newId: string) => void;
}

/** Loads the note body from disk and mounts the appropriate editor. Wrapping
 * `<NoteEditor>` in a separate container lets us handle the async load
 * without forcing the editor itself to deal with a "not loaded yet" state. */
export function NoteEditorContainer(props: NoteEditorContainerProps) {
  const { note } = props;
  const [content, setContent] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  // Bumped on every external reload so we can remount the inner editor
  // with the freshly-loaded content (its props are read-once at mount).
  const [reloadEpoch, setReloadEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setContent(undefined);
    setLoadError(undefined);
    helixApi
      .readNote(note.path)
      .then((body) => {
        if (cancelled) return;
        setContent(body);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setContent("");
      });
    return () => {
      cancelled = true;
    };
  }, [note.id, note.path]);

  const reload = useCallback(async () => {
    try {
      const body = await helixApi.readNote(note.path);
      setContent(body);
      setReloadEpoch((n) => n + 1);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [note.path]);

  if (loadError) {
    return (
      <div className="note-editor-error">
        <p>Failed to load note:</p>
        <pre>{loadError}</pre>
      </div>
    );
  }

  if (content === undefined) {
    return <div className="note-editor-loading">Loading…</div>;
  }

  return (
    <NoteEditor
      key={`${note.id}-${reloadEpoch}`}
      workspace={props.workspace}
      note={note}
      initialContent={content}
      onRenamed={props.onRenamed}
      onReloadFromDisk={reload}
    />
  );
}

interface NoteEditorProps {
  readonly workspace: WorkspaceRecord;
  readonly note: NoteRecord;
  readonly initialContent: string;
  readonly onRenamed: (newId: string) => void;
  /** Called when the user clicks "Reload from disk" in the conflict
   * banner. The container re-reads the file and bumps the editor key so
   * we remount with the new content. */
  readonly onReloadFromDisk: () => Promise<void> | void;
}

function NoteEditor({
  workspace,
  note,
  initialContent,
  onRenamed,
  onReloadFromDisk,
}: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>(() => loadEditorMode());
  // `content` is the source of truth shared between modes. Both editors
  // report changes here; switching modes hands the latest version off to
  // the other editor as its initial content.
  const [content, setContent] = useState<string>(initialContent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [savedAt, setSavedAt] = useState<string>(note.modifiedAt);
  // Set when another window writes the file under us. We surface a banner
  // instead of clobbering local edits silently.
  const [externalChangeAt, setExternalChangeAt] = useState<string | undefined>();

  // Track the path the editor is currently writing to. Renames swap this
  // out so subsequent saves land on the new file.
  const pathRef = useRef<string>(note.path);

  // Skip the very first onChange after mount — the editors emit one change
  // when they're populated with `initialContent`, and we don't want to mark
  // the note dirty (or trigger a save) just for opening it.
  const skipNextChangeRef = useRef(true);

  // Latest content in a ref so the debounced save callback always reads the
  // freshest value without re-creating the timer on every keystroke.
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Latest savedAt in a ref so the cross-window listener can de-dupe its
  // own write echo without re-binding on every save.
  const savedAtRef = useRef(savedAt);
  useEffect(() => {
    savedAtRef.current = savedAt;
  }, [savedAt]);

  const onModeToggle = useCallback(() => {
    setMode((curr) => {
      const next: EditorMode = curr === "rich" ? "raw" : "rich";
      saveEditorMode(next);
      // Both editors will emit a synthetic change on remount; skip it so we
      // don't mark the note dirty for a no-op view switch.
      skipNextChangeRef.current = true;
      return next;
    });
  }, []);

  const handleEditorChange = useCallback((next: string) => {
    if (skipNextChangeRef.current) {
      skipNextChangeRef.current = false;
      return;
    }
    setContent(next);
  }, []);

  // Debounced save. Re-scheduled on every content change; fires once when
  // typing pauses for SAVE_DEBOUNCE_MS. The mounted-skip ref prevents an
  // initial save on open.
  useEffect(() => {
    if (content === initialContent) return;
    const timer = window.setTimeout(async () => {
      setSaving(true);
      setSaveError(undefined);
      try {
        const result = await helixApi.writeNote(
          workspace.id,
          workspace.path,
          pathRef.current,
          contentRef.current,
          true, // renameIfUntitled
        );
        if (result.renamed) {
          pathRef.current = result.note.path;
          onRenamed(result.note.id);
        }
        setSavedAt(result.note.modifiedAt);
        // Our own write just landed; clear any stale "external change"
        // banner so we don't prompt the user to overwrite themselves.
        setExternalChangeAt(undefined);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [content, initialContent, workspace.id, workspace.path, onRenamed]);

  // Cross-window sync. When *another* window writes the same file, we get
  // a `helix://note-changed` event with the new record. If our editor is
  // clean we silently reload; if there are unsaved local edits we just
  // surface a banner and let the user choose.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<NoteRecord>(NOTE_CHANGED_EVENT, (event) => {
      const incoming = event.payload;
      if (!incoming) return;
      // Match by path — paths can move (rename) but within a single
      // editor session the pathRef tracks the live target.
      if (incoming.path !== pathRef.current) return;
      // De-dupe our own write echo: if mtime equals what we just saved,
      // this event came from us.
      if (incoming.modifiedAt === savedAtRef.current) return;
      const localDirty = contentRef.current !== initialContent;
      if (!localDirty) {
        // No work to lose — pull the new content in transparently.
        void onReloadFromDisk();
      } else {
        // Surface the conflict; user picks reload (lose local) or
        // continue editing (their next save overwrites the other window).
        setExternalChangeAt(incoming.modifiedAt);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [initialContent, onReloadFromDisk]);

  // The debounced save loop above guarantees every change lands on disk
  // within SAVE_DEBOUNCE_MS, so there's no useful "unsaved" state to show.
  // Surface only the in-flight write or a hard failure.
  const status = saveError
    ? `save failed: ${saveError}`
    : saving
      ? "saving…"
      : "saved";

  return (
    <section className="note-editor">
      <header className="note-editor-header">
        <div className="note-editor-title">
          <span className="note-editor-name" title={note.relativePath}>
            {note.title}
          </span>
          <span className="note-editor-path">{note.relativePath}</span>
        </div>
        <div className="note-editor-actions">
          <span className="note-editor-status" data-saving={saving || undefined}>
            {status}
          </span>
          <div className="note-editor-mode" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "rich"}
              data-active={mode === "rich" || undefined}
              onClick={() => mode !== "rich" && onModeToggle()}
            >
              Rich
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "raw"}
              data-active={mode === "raw" || undefined}
              onClick={() => mode !== "raw" && onModeToggle()}
            >
              Raw
            </button>
          </div>
        </div>
      </header>
      {externalChangeAt ? (
        <div className="note-editor-conflict" role="alert">
          <span>
            Another window saved this file at{" "}
            <code>{new Date(externalChangeAt).toLocaleTimeString()}</code>.
            Your in-progress edits will overwrite it on the next save.
          </span>
          <div className="note-editor-conflict-actions">
            <button
              type="button"
              className="note-editor-conflict-reload"
              onClick={() => {
                setExternalChangeAt(undefined);
                void onReloadFromDisk();
              }}
            >
              Reload from disk
            </button>
            <button
              type="button"
              className="note-editor-conflict-dismiss"
              onClick={() => setExternalChangeAt(undefined)}
            >
              Keep mine
            </button>
          </div>
        </div>
      ) : null}
      <div className="note-editor-body scroll">
        <Suspense fallback={<div className="note-editor-loading">Loading editor…</div>}>
          {mode === "rich" ? (
            <BlockNoteEditor
              key={`rich-${note.id}`}
              initialMarkdown={content}
              onChange={handleEditorChange}
            />
          ) : (
            <CodeMirrorEditor
              key={`raw-${note.id}`}
              initialDoc={content}
              onChange={handleEditorChange}
            />
          )}
        </Suspense>
      </div>
    </section>
  );
}
