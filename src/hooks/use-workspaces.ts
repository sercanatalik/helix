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

  const removeWorkspace = useCallback((id: WorkspaceId) => {
    setWorkspaces((curr) => curr.filter((w) => w.id !== id));
    setActiveId((curr) => (curr === id ? undefined : curr));
  }, []);

  return {
    workspaces,
    activeId: activeWorkspace?.id,
    activeWorkspace,
    setActive,
    addWorkspace,
    removeWorkspace,
  };
}
