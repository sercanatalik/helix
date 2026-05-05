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

export type ToolCallStatus = "running" | "complete" | "error";

/** Record of one MCP tool call that ran while producing the assistant
 * message it's attached to. Pushed onto the transcript as soon as the model
 * commits to the call (status: "running"), then patched to "complete" /
 * "error" with `result` filled in once the MCP server replies. Streaming
 * UIs can therefore render it live, Claude-Desktop-style. */
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
  /** Flat-text result returned by the tool. Empty while `status` is
   * "running"; populated when the call resolves or errors. */
  readonly result: string;
  readonly status: ToolCallStatus;
  /** Convenience flag mirroring `status === "error"`. Kept on the type so
   * older transcripts persisted without a `status` field still render
   * correctly when migrated. */
  readonly isError: boolean;
  readonly durationMs?: number;
  /** When this call is a sub-agent dispatch (`dispatch_agent`), the
   * sub-agent's own tool calls in execution order. Patched live as the
   * sub-agent streams so the user can watch the nested run unfold.
   * Undefined for ordinary tool calls; never set on the nested records
   * themselves (depth-1 only). */
  readonly nestedCalls?: readonly ToolCallRecord[];
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt: Timestamp;
  readonly status?: MessageStatus;
  /** Tool calls that ran while producing this assistant message, in order
   * of execution. Pushed live by `useChat` so the transcript can show each
   * call as it happens — running, then resolved with output. */
  readonly toolCalls?: readonly ToolCallRecord[];
  /** Raw chain-of-thought / "thinking" tokens emitted by the model, when
   * the provider surfaces them (DeepSeek-R1, Qwen, Anthropic-via-proxy).
   * Streamed in alongside `content`; rendered as a collapsible block. */
  readonly reasoning?: string;
  readonly reasoningStatus?: "streaming" | "complete";
}

export interface SessionRecord {
  readonly id: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly status: SessionStatus;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly transcript: readonly TranscriptMessage[];
  /** Context-reset boundary. Messages with `createdAt` strictly less than
   * this timestamp stay visible in the transcript but are excluded from the
   * model-side message stack — used to drop stale conversation history
   * without losing the visible record. Cleared / reset by clicking the
   * context-usage chip in the composer. */
  readonly contextResetAt?: Timestamp;
}

export type SessionKey = `${WorkspaceId}::${SessionId}`;

/** Where a skill came from. Mirrors Claude Code's precedence model: project
 * overrides user, both override built-in. `builtin` skills ship inside the
 * helix binary — no filesystem dependency. */
export type SkillSource = "builtin" | "user" | "project";

/** A skill — either embedded in the helix binary (`builtin`) or discovered on
 * disk under `~/.claude/skills/<name>/SKILL.md` (`user`) or
 * `<workspace>/.claude/skills/<name>/SKILL.md` (`project`). The wire shape
 * mirrors Claude Code's frontmatter fields plus a few helix-specific fields
 * used for UI state (`id`, `source`, `error`). */
export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly argumentHint?: string;
  /** Names of declared positional arguments. Used for `$name` substitution
   * inside the skill body. */
  readonly arguments?: readonly string[];
  /** When true, only the user can invoke the skill via `/name`. The model
   * never auto-discovers it. */
  readonly disableModelInvocation: boolean;
  /** When false, the skill is hidden from the slash menu — used for
   * background-knowledge skills the model should know about but the user
   * shouldn't run directly. */
  readonly userInvocable: boolean;
  readonly allowedTools?: readonly string[];
  readonly paths?: readonly string[];
  /** The markdown body following the frontmatter. Pre-loaded so invocation
   * doesn't require a follow-up read; used by the rendered system message. */
  readonly body: string;
  readonly source: SkillSource;
  readonly directory: string;
  readonly skillMdPath: string;
  /** Set when frontmatter parsing or file reading failed. The skill still
   * shows up in the list so the user can see what's broken. */
  readonly error?: string;
}

export type NoteId = string;

/** A markdown note discovered by the Rust scanner under the active
 * workspace folder. The id is a stable hash of the absolute path so the
 * frontend's `activeNoteId` survives rescans + relaunches. */
export interface NoteRecord {
  readonly id: NoteId;
  readonly workspaceId: WorkspaceId;
  /** Absolute path on disk. Treated as opaque by the UI. */
  readonly path: string;
  /** Path relative to the workspace root, forward-slash separated. */
  readonly relativePath: string;
  readonly title: string;
  readonly snippet: string;
  readonly modifiedAt: Timestamp;
}

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
  readonly skills: readonly Skill[];
  readonly notes: readonly NoteRecord[];
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
    skills: [],
    notes: [],
  };
}
