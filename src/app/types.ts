import type { ThemeId } from "../themes";

export type WorkspaceId = string;
export type SessionId = string;
export type Timestamp = string;
export type AppView = "chat" | "settings";

export const BASIC_AUTH_HEADER_NAME = "x-client-secret";

export type McpTransport = "http" | "stdio";

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface CustomHeader {
  readonly name: string;
  readonly value: string;
}

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly customHeaders?: readonly CustomHeader[];
  readonly attachBasicAuthHeader?: boolean;
  readonly sourceKey?: string;
  /** Tools the user has hidden from the model. Opt-out — anything not in
   * this list is exposed by default. */
  readonly disabledTools?: readonly string[];
  /** Prompts the user has chosen to inject as hidden system context every
   * message. Opt-in — defaults to empty so we don't auto-prepend everything
   * a server advertises. */
  readonly enabledPrompts?: readonly string[];
}

export type McpServerInput = Omit<McpServerConfig, "id">;

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  /** Tags advertised by the server (FastMCP `_meta._fastmcp.tags`, or a
   * top-level `tags` array on the tool's `_meta`). Empty / absent when the
   * server does not publish any. */
  readonly tags?: readonly string[];
  /** The full `_meta` payload as advertised by the server, passed through
   * verbatim. FastMCP namespaces extras under keys like `_fastmcp`. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpPromptInfo {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpResourceInfo {
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpServerRuntime {
  readonly status: McpConnectionStatus;
  readonly error?: string;
  readonly tools: readonly McpToolInfo[];
  readonly prompts: readonly McpPromptInfo[];
  readonly resources: readonly McpResourceInfo[];
  /** Per-list discovery error. Populated when the server replied to the
   * matching `tools/list` / `prompts/list` / `resources/list` request with
   * an error (e.g. method-not-supported). Distinct from a successful empty
   * response, which leaves these undefined and yields a count of 0. */
  readonly toolsError?: string;
  readonly promptsError?: string;
  readonly resourcesError?: string;
  readonly lastConnectedAt?: Timestamp;
}

export interface McpPromptResult {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly error?: string;
}

export interface McpResourceResult {
  readonly content: string;
  readonly error?: string;
}

export interface McpCallToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export interface McpTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly toolCount?: number;
  readonly promptCount?: number;
  readonly resourceCount?: number;
  /** Per-list discovery error returned by the server during the test
   * connection — same semantics as McpServerRuntime.{tools,prompts,resources}Error. */
  readonly toolsError?: string;
  readonly promptsError?: string;
  readonly resourcesError?: string;
  readonly durationMs?: number;
}

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly path: string;
  readonly displayName: string;
  readonly createdAt: Timestamp;
}

export type SessionStatus = "idle" | "running" | "failed";

export type MessageStatus = "streaming" | "complete" | "error";

/** Record of one MCP tool call that ran while producing the assistant
 * message it's attached to. Kept on the transcript so the user can
 * retroactively inspect what the model did, even though the call itself
 * stays hidden during streaming. */
export interface ToolCallRecord {
  readonly id: string;
  readonly serverId: string;
  readonly serverName?: string;
  readonly toolName: string;
  /** JSON-encoded arguments string as sent to the server. Stored as the
   * raw stream — the agent loop accumulates this from streaming deltas, so
   * keeping it as a string preserves whatever the model emitted (including
   * partial-but-valid JSON). */
  readonly arguments: string;
  /** Flat-text result returned by the tool. Errors are also stored here
   * (with `isError: true` set) so the debug panel can render them
   * uniformly. */
  readonly result: string;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: Timestamp;
  readonly status?: MessageStatus;
  /** Tool calls that ran while producing this assistant message, in order
   * of execution. Populated by `useChat` after each agent-loop iteration;
   * the user only sees them by clicking the debug icon. */
  readonly toolCalls?: readonly ToolCallRecord[];
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
  readonly mcpServers: readonly McpServerConfig[];
  readonly mcpRuntime: Readonly<Record<string, McpServerRuntime>>;
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
    mcpServers: [],
    mcpRuntime: {},
  };
}
