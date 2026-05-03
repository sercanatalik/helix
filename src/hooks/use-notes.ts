import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { helixApi } from "../lib/tauri-api";
import {
  loadActiveNoteIdByWorkspace,
  saveActiveNoteIdByWorkspace,
} from "../lib/notes/storage";
import type {
  NoteId,
  NoteRecord,
  WorkspaceId,
  WorkspaceRecord,
} from "../app/types";

export interface UseNotesResult {
  readonly notes: readonly NoteRecord[];
  readonly activeId: NoteId | undefined;
  readonly activeNote: NoteRecord | undefined;
  readonly setActive: (id: NoteId | undefined) => void;
  readonly createNote: () => Promise<NoteRecord | undefined>;
  readonly deleteNote: (id: NoteId) => Promise<void>;
  /** Re-read the workspace from disk. Called automatically when the
   * workspace changes and on every `workspace-tree-changed` event. */
  readonly refresh: () => Promise<void>;
  /** Loading flag for the initial scan after workspace switch. The list
   * stays mounted while refreshing so the sidebar doesn't flicker. */
  readonly loading: boolean;
  readonly error: string | undefined;
}

export function useNotes(workspace: WorkspaceRecord | undefined): UseNotesResult {
  const [notes, setNotes] = useState<readonly NoteRecord[]>([]);
  const [activeIdByWorkspace, setActiveIdByWorkspace] = useState<
    Record<WorkspaceId, NoteId>
  >(() => loadActiveNoteIdByWorkspace());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Track the in-flight workspace so a stale rescan from a previous
  // workspace doesn't overwrite the new list.
  const inflightRef = useRef<string | undefined>(undefined);

  const workspaceId = workspace?.id;
  const workspacePath = workspace?.path;

  const refresh = useCallback(async () => {
    if (!workspaceId || !workspacePath) {
      setNotes([]);
      return;
    }
    inflightRef.current = workspaceId;
    setLoading(true);
    setError(undefined);
    try {
      const next = await helixApi.listNotes(workspaceId, workspacePath);
      if (inflightRef.current !== workspaceId) return;
      setNotes(next);
    } catch (e) {
      if (inflightRef.current !== workspaceId) return;
      setError(e instanceof Error ? e.message : String(e));
      setNotes([]);
    } finally {
      if (inflightRef.current === workspaceId) {
        setLoading(false);
      }
    }
  }, [workspaceId, workspacePath]);

  // Initial load + reload on workspace change. The dependency array picks
  // up workspace changes via the inner closure.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The Rust side already emits `workspace-tree-changed` for every fs event
  // inside the watched folder. Piggyback on that — debounced on the Rust
  // side already, so a fresh refresh per event is cheap. Listening here
  // (not in App.tsx) keeps the wiring local to notes.
  useEffect(() => {
    if (!workspaceId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("workspace-tree-changed", () => {
      void refresh();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workspaceId, refresh]);

  // Persist active-id-per-workspace whenever it changes.
  useEffect(() => {
    saveActiveNoteIdByWorkspace(activeIdByWorkspace);
  }, [activeIdByWorkspace]);

  const activeId = workspaceId ? activeIdByWorkspace[workspaceId] : undefined;

  // Resolve the active note for the current workspace. If the pinned id
  // points at something that no longer exists (deleted, moved, workspace
  // changed), fall back to the newest note instead of returning undefined
  // — matches `use-sessions.ts` behavior.
  const activeNote = useMemo<NoteRecord | undefined>(() => {
    if (notes.length === 0) return undefined;
    if (activeId) {
      const pinned = notes.find((n) => n.id === activeId);
      if (pinned) return pinned;
    }
    return undefined;
  }, [notes, activeId]);

  const setActive = useCallback(
    (id: NoteId | undefined) => {
      if (!workspaceId) return;
      setActiveIdByWorkspace((curr) => {
        const next = { ...curr };
        if (id) next[workspaceId] = id;
        else delete next[workspaceId];
        return next;
      });
    },
    [workspaceId],
  );

  const createNote = useCallback(async (): Promise<NoteRecord | undefined> => {
    if (!workspaceId || !workspacePath) return undefined;
    try {
      const note = await helixApi.createNote(workspaceId, workspacePath);
      // Optimistically prepend; the watcher will rescan and replace shortly.
      setNotes((curr) => [note, ...curr.filter((n) => n.id !== note.id)]);
      setActive(note.id);
      return note;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }, [workspaceId, workspacePath, setActive]);

  const deleteNote = useCallback(
    async (id: NoteId): Promise<void> => {
      if (!workspaceId || !workspacePath) return;
      const target = notes.find((n) => n.id === id);
      if (!target) return;
      try {
        const next = await helixApi.deleteNote(
          workspaceId,
          workspacePath,
          target.path,
        );
        setNotes(next);
        setActiveIdByWorkspace((curr) => {
          if (curr[workspaceId] !== id) return curr;
          const copy = { ...curr };
          delete copy[workspaceId];
          return copy;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [workspaceId, workspacePath, notes],
  );

  return {
    notes,
    activeId,
    activeNote,
    setActive,
    createNote,
    deleteNote,
    refresh,
    loading,
    error,
  };
}
