import { invoke } from "@tauri-apps/api/core";
import type { NoteRecord } from "../../app/types";

// Markdown notes in the attached workspace folder. `listNotes` rescans
// the disk on every call — cheap enough at MAX_NOTES (5000) that we
// don't bother caching client-side.

export interface WriteNoteResult {
  readonly note: NoteRecord;
  /** True when the file was renamed because the H1 changed and the prior
   * path was an `untitled-*.md` placeholder. Frontend swaps the active id
   * over to `note.id` when this is set. */
  readonly renamed: boolean;
}

export const notesApi = {
  listNotes: (
    workspaceId: string,
    workspacePath: string,
  ): Promise<NoteRecord[]> =>
    invoke<NoteRecord[]>("list_notes", { workspaceId, workspacePath }),

  /** Read the full body of a note off disk. Hard-capped at 5 MB. */
  readNote: (path: string): Promise<string> =>
    invoke<string>("read_note", { path }),

  /** Persist a note's body. When `renameIfUntitled` is true and the file
   * is currently `untitled-N.md`, the backend slugifies the H1 and renames
   * the file in one atomic step. The returned record's id may differ from
   * the call's input — swap the frontend's active id to `note.id` when
   * `renamed` is true. */
  writeNote: (
    workspaceId: string,
    workspacePath: string,
    path: string,
    content: string,
    renameIfUntitled: boolean,
  ): Promise<WriteNoteResult> =>
    invoke<WriteNoteResult>("write_note", {
      workspaceId,
      workspacePath,
      path,
      content,
      renameIfUntitled,
    }),

  /** Create a new `untitled-N.md` file at the workspace root and return
   * its record. Counts up until it finds a free slot. */
  createNote: (
    workspaceId: string,
    workspacePath: string,
  ): Promise<NoteRecord> =>
    invoke<NoteRecord>("create_note", { workspaceId, workspacePath }),

  /** Permanently delete a note from disk. Refuses paths outside the
   * workspace as a guardrail; returns the freshly-rescanned note list. */
  deleteNote: (
    workspaceId: string,
    workspacePath: string,
    path: string,
  ): Promise<NoteRecord[]> =>
    invoke<NoteRecord[]>("delete_note", { workspaceId, workspacePath, path }),

  /** Build a single NoteRecord without scanning the whole workspace.
   * Used by detached note windows during hydration. */
  getNoteRecord: (
    workspaceId: string,
    workspacePath: string,
    path: string,
  ): Promise<NoteRecord> =>
    invoke<NoteRecord>("get_note_record", {
      workspaceId,
      workspacePath,
      path,
    }),

  /** Open the given note in its own detached Tauri window. Idempotent —
   * a second call for the same note id just focuses the existing window. */
  openNoteWindow: (
    workspaceId: string,
    workspacePath: string,
    notePath: string,
    noteId: string,
    title: string,
  ): Promise<void> =>
    invoke<void>("open_note_window", {
      workspaceId,
      workspacePath,
      notePath,
      noteId,
      title,
    }),
};
