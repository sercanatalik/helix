import { useEffect, useState } from "react";
import { helixApi } from "../../lib/tauri-api";
import type { NoteRecord, WorkspaceRecord } from "../../app/types";
import { NoteEditorContainer } from "./note-editor";

/** Params encoded into the URL by `open_note_window` on the Rust side.
 * The detached window has no shared state with the main one — everything
 * it needs to render the editor comes through here. */
interface NoteWindowParams {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly notePath: string;
}

function readParams(): NoteWindowParams | undefined {
  const search = new URLSearchParams(window.location.search);
  const workspaceId = search.get("workspaceId");
  const workspacePath = search.get("workspacePath");
  const notePath = search.get("notePath");
  if (!workspaceId || !workspacePath || !notePath) return undefined;
  return { workspaceId, workspacePath, notePath };
}

/** Top-level shell for a detached note window. Owns hydration (fetch the
 * NoteRecord off disk once), then hands off to the same `NoteEditorContainer`
 * the main window uses. Keeping the editor component shared means rich/raw
 * mode, autosave, and rename-on-H1 all behave identically across windows. */
export function NoteWindow() {
  const [params] = useState<NoteWindowParams | undefined>(() => readParams());
  const [note, setNote] = useState<NoteRecord | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!params) {
      setError("note window opened without the required URL parameters");
      return;
    }
    let cancelled = false;
    helixApi
      .getNoteRecord(params.workspaceId, params.workspacePath, params.notePath)
      .then((rec) => {
        if (!cancelled) setNote(rec);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  // The note window doesn't need a full WorkspaceRecord — only the id and
  // path are read by the editor's save loop. Synthesize a minimal one to
  // avoid hauling the whole workspace list across windows.
  const workspaceShim: WorkspaceRecord | undefined = params
    ? {
        id: params.workspaceId,
        path: params.workspacePath,
        displayName: params.workspacePath.split("/").pop() ?? "Workspace",
        createdAt: new Date().toISOString(),
      }
    : undefined;

  if (error) {
    return (
      <div className="note-window-error">
        <h2>Cannot open note</h2>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!note || !workspaceShim) {
    return <div className="note-window-loading">Loading note…</div>;
  }

  return (
    <div className="note-window">
      <NoteEditorContainer
        workspace={workspaceShim}
        note={note}
        onRenamed={(newId) => {
          // The backend rename moved the file already; the editor's
          // pathRef now points at the new path. Just bump the id locally
          // so the header/key reflect the new note.
          setNote((curr) => (curr ? { ...curr, id: newId } : curr));
        }}
      />
    </div>
  );
}
