import type { WorkspaceId, WorkspaceRecord } from "../../app/types";

const KEY = "helix.workspaces.v1";
const ACTIVE_KEY = "helix.active-workspace.v1";

export function loadWorkspaces(): readonly WorkspaceRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as WorkspaceRecord[];
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: readonly WorkspaceRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(workspaces));
  } catch {
    // Best-effort.
  }
}

export function loadActiveWorkspaceId(): WorkspaceId | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(ACTIVE_KEY);
  return raw && raw.length > 0 ? raw : undefined;
}

export function saveActiveWorkspaceId(id: WorkspaceId | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Best-effort.
  }
}

export function newWorkspaceId(): WorkspaceId {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
