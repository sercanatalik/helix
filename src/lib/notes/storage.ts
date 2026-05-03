import type { NoteId, WorkspaceId } from "../../app/types";

// Active note is tracked per workspace so switching workspaces and back
// returns you to the note you were editing rather than the most recent one.
const KEY = "helix.active-note-by-workspace.v1";
const VIEW_KEY = "helix.note-editor-mode.v1";
const OPEN_KEY = "helix.open-note-ids-by-workspace.v1";

export type EditorMode = "rich" | "raw";

export function loadActiveNoteIdByWorkspace(): Record<WorkspaceId, NoteId> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<WorkspaceId, NoteId>;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveActiveNoteIdByWorkspace(
  map: Record<WorkspaceId, NoteId>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Best-effort.
  }
}

// Per-workspace ordered list of "open" note tabs in the main dock. Survives
// relaunch so the user comes back to the same tabs they had yesterday. The
// active note id (above) determines which of these tabs is focused.
export function loadOpenNoteIdsByWorkspace(): Record<WorkspaceId, NoteId[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<WorkspaceId, NoteId[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        out[k] = v as NoteId[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveOpenNoteIdsByWorkspace(
  map: Record<WorkspaceId, NoteId[]>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch {
    // Best-effort.
  }
}

export function loadEditorMode(): EditorMode {
  if (typeof window === "undefined") return "rich";
  const raw = window.localStorage.getItem(VIEW_KEY);
  return raw === "raw" ? "raw" : "rich";
}

export function saveEditorMode(mode: EditorMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // Best-effort.
  }
}
