import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadActiveWorkspaceId,
  loadWorkspaces,
  newWorkspaceId,
  saveActiveWorkspaceId,
  saveWorkspaces,
} from "../lib/workspaces/storage";
import type { WorkspaceId, WorkspaceRecord } from "../app/types";

const DEFAULT_NAME = "Helix";

export interface UseWorkspacesResult {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly activeId: WorkspaceId | undefined;
  readonly activeWorkspace: WorkspaceRecord | undefined;
  readonly setActive: (id: WorkspaceId) => void;
  readonly addWorkspace: (displayName: string, path?: string) => WorkspaceId;
  readonly renameWorkspace: (id: WorkspaceId, displayName: string) => void;
  readonly setWorkspacePath: (id: WorkspaceId, path: string) => void;
  /** Removes the workspace from the list. The hook does not touch the
   * caller's session/note storage — orchestrate that cleanup at the call
   * site so all per-workspace state lands in a single update. */
  readonly removeWorkspace: (id: WorkspaceId) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeWorkspace(displayName: string, path = ""): WorkspaceRecord {
  return {
    id: newWorkspaceId(),
    displayName: displayName.trim() || DEFAULT_NAME,
    path,
    createdAt: nowIso(),
  };
}

export function useWorkspaces(): UseWorkspacesResult {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>(
    () => {
      const loaded = loadWorkspaces();
      if (loaded.length > 0) return loaded;
      // First-ever launch — seed a default workspace so the app has somewhere
      // to put the user's first chat. Subsequent runs respect deletions.
      return [makeWorkspace(DEFAULT_NAME)];
    },
  );
  const [activeId, setActiveId] = useState<WorkspaceId | undefined>(() =>
    loadActiveWorkspaceId(),
  );

  const activeWorkspace = useMemo<WorkspaceRecord | undefined>(() => {
    if (activeId) {
      const pinned = workspaces.find((w) => w.id === activeId);
      if (pinned) return pinned;
    }
    return workspaces[0];
  }, [workspaces, activeId]);

  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

  useEffect(() => {
    saveActiveWorkspaceId(activeWorkspace?.id);
  }, [activeWorkspace?.id]);

  const setActive = useCallback((id: WorkspaceId) => {
    setActiveId(id);
  }, []);

  const addWorkspace = useCallback(
    (displayName: string, path = ""): WorkspaceId => {
      const ws = makeWorkspace(displayName, path);
      setWorkspaces((curr) => [...curr, ws]);
      setActiveId(ws.id);
      return ws.id;
    },
    [],
  );

  const renameWorkspace = useCallback(
    (id: WorkspaceId, displayName: string) => {
      const trimmed = displayName.trim();
      if (!trimmed) return;
      setWorkspaces((curr) =>
        curr.map((w) => (w.id === id ? { ...w, displayName: trimmed } : w)),
      );
    },
    [],
  );

  const setWorkspacePath = useCallback((id: WorkspaceId, path: string) => {
    setWorkspaces((curr) =>
      curr.map((w) => (w.id === id ? { ...w, path } : w)),
    );
  }, []);

  const removeWorkspace = useCallback((id: WorkspaceId) => {
    setWorkspaces((curr) => {
      // Refuse to drop the last workspace — the rest of the app (sidebar,
      // panel, sessions) assumes at least one exists.
      if (curr.length <= 1) return curr;
      return curr.filter((w) => w.id !== id);
    });
    setActiveId((curr) => (curr === id ? undefined : curr));
  }, []);

  return {
    workspaces,
    activeId: activeWorkspace?.id,
    activeWorkspace,
    setActive,
    addWorkspace,
    renameWorkspace,
    setWorkspacePath,
    removeWorkspace,
  };
}
