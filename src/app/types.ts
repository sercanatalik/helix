import type { ThemeId } from "../themes";

export type WorkspaceId = string;
export type SessionId = string;
export type Timestamp = string;
export type AppView = "chat" | "settings";

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly displayName: string;
  readonly createdAt: Timestamp;
}

export type SessionStatus = "idle" | "running" | "failed";

export type MessageStatus = "streaming" | "complete" | "error";

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: Timestamp;
  readonly status?: MessageStatus;
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly transcript: readonly TranscriptMessage[];
}

export type SessionKey = `${WorkspaceId}::${SessionId}`;

export interface DesktopAppState {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId?: WorkspaceId;
  readonly sessions: Readonly<Record<SessionKey, SessionRecord>>;
  readonly selectedSessionIdByWorkspace: Readonly<
    Record<WorkspaceId, SessionId | undefined>
  >;
  readonly theme: ThemeId;
  readonly activeView: AppView;
}

export function sessionKey(
  workspaceId: WorkspaceId,
  sessionId: SessionId,
): SessionKey {
  return `${workspaceId}::${sessionId}`;
}

export function createEmptyState(): DesktopAppState {
  return {
    workspaces: [],
    sessions: {},
    selectedSessionIdByWorkspace: {},
    theme: "meridian-light",
    activeView: "chat",
  };
}
