import type { SessionId, SessionRecord } from "../../app/types";

const KEY = "helix.sessions.v1";
const ACTIVE_KEY = "helix.active-session.v1";

export function loadSessions(): readonly SessionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SessionRecord[];
  } catch {
    return [];
  }
}

export function saveSessions(sessions: readonly SessionRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sessions));
  } catch {
    // Quota / privacy mode — best-effort only.
  }
}

export function loadActiveSessionId(): SessionId | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(ACTIVE_KEY);
  return raw && raw.length > 0 ? raw : undefined;
}

export function saveActiveSessionId(id: SessionId | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Best-effort.
  }
}

export function newSessionId(): SessionId {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
