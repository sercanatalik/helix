import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadActiveSessionId,
  loadSessions,
  newSessionId,
  saveActiveSessionId,
  saveSessions,
} from "../lib/sessions/storage";
import type {
  SessionId,
  SessionRecord,
  Timestamp,
  TranscriptMessage,
  WorkspaceId,
} from "../app/types";

const NEW_TITLE = "New chat";

export interface UseSessionsResult {
  /** Sessions belonging to the active workspace, all stored in storage but
   * filtered for this workspace at read time. */
  readonly sessions: readonly SessionRecord[];
  readonly activeId: SessionId | undefined;
  readonly activeSession: SessionRecord | undefined;
  readonly setActive: (id: SessionId) => void;
  readonly createSession: () => SessionId;
  readonly deleteSession: (id: SessionId) => void;
  readonly setMessages: (
    id: SessionId,
    messages: readonly TranscriptMessage[],
  ) => void;
  /** Mark the context-reset boundary at the current moment — older
   * transcript messages stay visible but stop riding along on subsequent
   * model calls. Pass `undefined` to clear the boundary. */
  readonly setContextResetAt: (
    id: SessionId,
    timestamp: Timestamp | undefined,
  ) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEmptySession(workspaceId: WorkspaceId): SessionRecord {
  return {
    id: newSessionId(),
    workspaceId,
    title: NEW_TITLE,
    status: "idle",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    transcript: [],
  };
}

/** Derive a session title from the first user message — first 60 chars,
 * collapsed whitespace. Falls back to NEW_TITLE if there's nothing yet. */
function deriveTitle(messages: readonly TranscriptMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return NEW_TITLE;
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  if (!cleaned) return NEW_TITLE;
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
}

/** Sessions are stored as one global list, each tagged with a workspaceId.
 * The hook filters to the supplied workspace, so switching workspaces just
 * means calling this with a different id. */
export function useSessions(
  workspaceId: WorkspaceId | undefined,
): UseSessionsResult {
  const [allSessions, setAllSessions] = useState<readonly SessionRecord[]>(
    () => loadSessions(),
  );
  const [activeId, setActiveId] = useState<SessionId | undefined>(() =>
    loadActiveSessionId(),
  );

  // Sessions visible in the current workspace.
  const sessions = useMemo<readonly SessionRecord[]>(
    () =>
      workspaceId
        ? allSessions.filter((s) => s.workspaceId === workspaceId)
        : [],
    [allSessions, workspaceId],
  );

  // Resolve the active session for the *current workspace*. If the pinned
  // active id belongs to a different workspace, fall back to the most
  // recently updated session here.
  const activeSession = useMemo<SessionRecord | undefined>(() => {
    if (activeId) {
      const pinned = sessions.find((s) => s.id === activeId);
      if (pinned) return pinned;
    }
    if (sessions.length === 0) return undefined;
    return [...sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )[0];
  }, [sessions, activeId]);

  useEffect(() => {
    saveSessions(allSessions);
  }, [allSessions]);

  useEffect(() => {
    saveActiveSessionId(activeSession?.id);
  }, [activeSession?.id]);

  const setActive = useCallback((id: SessionId) => {
    setActiveId(id);
  }, []);

  const createSession = useCallback((): SessionId => {
    if (!workspaceId) {
      throw new Error("createSession called with no active workspace.");
    }
    const fresh = makeEmptySession(workspaceId);
    setAllSessions((curr) => [fresh, ...curr]);
    setActiveId(fresh.id);
    return fresh.id;
  }, [workspaceId]);

  const deleteSession = useCallback((id: SessionId) => {
    setAllSessions((curr) => curr.filter((s) => s.id !== id));
    setActiveId((curr) => (curr === id ? undefined : curr));
  }, []);

  const setMessages = useCallback(
    (id: SessionId, messages: readonly TranscriptMessage[]) => {
      setAllSessions((curr) =>
        curr.map((s) =>
          s.id === id
            ? {
                ...s,
                transcript: messages,
                title: s.title === NEW_TITLE ? deriveTitle(messages) : s.title,
                updatedAt: nowIso(),
              }
            : s,
        ),
      );
    },
    [],
  );

  const setContextResetAt = useCallback(
    (id: SessionId, timestamp: Timestamp | undefined) => {
      setAllSessions((curr) =>
        curr.map((s) =>
          s.id === id
            ? { ...s, contextResetAt: timestamp, updatedAt: nowIso() }
            : s,
        ),
      );
    },
    [],
  );

  return {
    sessions,
    activeId: activeSession?.id,
    activeSession,
    setActive,
    createSession,
    deleteSession,
    setMessages,
    setContextResetAt,
  };
}
