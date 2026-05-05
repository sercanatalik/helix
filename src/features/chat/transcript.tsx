import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../components/markdown";
import type {
  ToolCallRecord,
  ToolCallStatus,
  TranscriptMessage,
} from "../../app/types";

interface TranscriptProps {
  readonly messages: readonly TranscriptMessage[];
  /** Timestamp of the most recent context reset. The first message at or
   * after this point gets a divider above it indicating older messages no
   * longer ride along on model calls. */
  readonly contextResetAt?: string;
}

export function Transcript({ messages, contextResetAt }: TranscriptProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Coalesce auto-scrolls into one per animation frame; streaming patches
  // produce a new transcript reference on every chunk and synchronous
  // scrollIntoView would force a layout per chunk.
  useEffect(() => {
    let frame: number | null = null;
    frame = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [messages]);

  // Find the index of the first message at-or-after the cutoff so we know
  // where to drop the divider. Skip the divider entirely when there's nothing
  // older than it (the reset would be a no-op visually).
  const dividerBeforeId = useMemo(() => {
    if (!contextResetAt) return null;
    const idx = messages.findIndex((m) => m.createdAt >= contextResetAt);
    if (idx <= 0) return null;
    return messages[idx]!.id;
  }, [messages, contextResetAt]);

  return (
    <section className="transcript scroll">
      <div className="transcript-inner">
        {messages.map((msg) => (
          <Fragment key={msg.id}>
            {msg.id === dividerBeforeId ? <ContextResetDivider /> : null}
            <MessageView message={msg} stale={
              dividerBeforeId !== null && !!contextResetAt && msg.createdAt < contextResetAt
            } />
          </Fragment>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function ContextResetDivider() {
  return (
    <div
      className="context-reset-divider"
      role="separator"
      aria-label="Context reset — earlier messages are no longer sent to the model"
    >
      <span className="context-reset-divider-line" aria-hidden />
      <span className="context-reset-divider-label">Context reset</span>
      <span className="context-reset-divider-line" aria-hidden />
    </div>
  );
}

interface MessageViewProps {
  readonly message: TranscriptMessage;
  /** True when this message sits before the active context-reset boundary.
   * Visible in the transcript but no longer part of the model-side stack. */
  readonly stale?: boolean;
}

// Memoized so streaming token patches — which only mutate the active
// assistant message — don't cascade re-renders across every prior message.
// `use-chat`'s `patch` is a `prev.map(...)` that preserves identity for
// untouched messages, so the default shallow compare is enough.
const MessageView = memo(MessageViewImpl);

function MessageViewImpl({ message, stale = false }: MessageViewProps) {
  const streaming = message.status === "streaming";
  const isAssistant = message.role === "assistant";
  // Tool rows ride along on every assistant message — live during streaming,
  // then collapsed under a one-line summary once the message finalizes so
  // the prose answer wins the visual hierarchy. The collapsed form keeps a
  // breadcrumb (server, tool names, retries, total time) the user can
  // expand if they need to audit what ran.
  const toolCalls = message.toolCalls ?? [];
  const reasoning = message.reasoning ?? "";
  const reasoningStreaming =
    streaming && message.reasoningStatus !== "complete";
  // Show the "Churning…▎" line whenever the assistant is working but the
  // user can't otherwise tell — i.e. no live text yet AND reasoning isn't
  // animating its own cursor. Tool calls in flight count as "working with
  // nothing to type yet", so we keep the cursor visible across them; once
  // post-tool content starts streaming, the typed text itself is the live
  // edge and the status line steps out of the way.
  const showStatusLine =
    isAssistant &&
    streaming &&
    !reasoningStreaming &&
    !message.content;
  const verb = useRotatingVerb(isAssistant && streaming);

  return (
    <div
      className="msg"
      data-role={message.role}
      data-status={message.status}
      data-stale={stale ? "true" : undefined}
    >
      <div className="msg-avatar" data-role={message.role} aria-hidden>
        {isAssistant ? "HX" : "ME"}
      </div>
      <div className="msg-body">
        <div className="msg-meta">
          <span className="msg-name">{isAssistant ? "Helix" : "You"}</span>
          <span className="msg-time">{formatMessageTime(message.createdAt)}</span>
        </div>
        <div className="msg-content">
          {isAssistant && reasoning ? (
            <ReasoningBlock
              text={reasoning}
              streaming={reasoningStreaming}
              verb={verb}
            />
          ) : null}
          {isAssistant && toolCalls.length > 0 ? (
            <ToolCallGroupList calls={toolCalls} streaming={streaming} />
          ) : null}
          {showStatusLine ? <StreamingStatus verb={verb} /> : null}
          {isAssistant ? (
            <Markdown content={message.content} streaming={streaming} />
          ) : (
            <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {renderUserBody(message.content)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function formatMessageTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// Match a leading `/skillname` token (word chars + hyphens) optionally
// followed by whitespace and arguments. We don't validate the name against
// the loaded skill list — the visual cue means "this looks like a slash
// command", which holds even for typos or removed skills.
const SLASH_TOKEN_RE = /^(\/[\w-]+)(\s[\s\S]*)?$/;

function renderUserBody(content: string) {
  const match = SLASH_TOKEN_RE.exec(content);
  if (!match) return content;
  return (
    <>
      <span className="msg-slash-token">{match[1]}</span>
      {match[2] ?? ""}
    </>
  );
}

/* ---------- Streaming status (Claude Code "Churning…" parity) ---------- */

/** Whimsical activity verbs Claude Code rotates through while it's working.
 * Picked to be evocative without being technical — gives the user a sense
 * the system is busy without committing to a specific phase ("planning",
 * "executing", etc.) that we can't reliably detect from the wire format. */
const ACTIVITY_VERBS = [
  "Churning",
  "Pondering",
  "Cogitating",
  "Mulling",
  "Ruminating",
  "Stewing",
  "Brewing",
  "Simmering",
  "Marinating",
  "Percolating",
  "Steeping",
  "Noodling",
  "Reasoning",
  "Thinking",
  "Considering",
  "Weighing",
  "Untangling",
  "Wrangling",
  "Schlepping",
  "Conjuring",
];

/** Pick a verb at mount, then rotate every ~2.4s while `active` is true.
 * The mount-time random pick avoids every assistant message starting on the
 * same word — over a long session the rotation would still drift in step
 * across messages otherwise. */
function useRotatingVerb(active: boolean): string {
  const [idx, setIdx] = useState(
    () => Math.floor(Math.random() * ACTIVITY_VERBS.length),
  );
  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(
      () => setIdx((i) => (i + 1) % ACTIVITY_VERBS.length),
      5000,
    );
    return () => window.clearInterval(handle);
  }, [active]);
  return ACTIVITY_VERBS[idx] ?? "Thinking";
}

function StreamingStatus({ verb }: { readonly verb: string }) {
  return (
    <div className="streaming-status" aria-live="polite">
      <span className="streaming-status-verb">{verb}…</span>
      <BlinkingCursor />
    </div>
  );
}

function BlinkingCursor() {
  return <span className="blinking-cursor" aria-hidden />;
}

/* ---------- Reasoning block (Claude Desktop "Thinking…" parity) ---------- */

function ReasoningBlock({
  text,
  streaming,
  verb,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly verb: string;
}) {
  // While the model is still thinking, default-expand so the user sees the
  // text scroll past. Once it finishes, collapse back to a one-line summary
  // — the user can click to re-open the full transcript.
  const [open, setOpen] = useState(true);
  const previouslyStreamingRef = useRef(streaming);
  useEffect(() => {
    if (previouslyStreamingRef.current && !streaming) {
      setOpen(false);
    }
    previouslyStreamingRef.current = streaming;
  }, [streaming]);

  return (
    <div
      className="thinking-block"
      data-streaming={streaming || undefined}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="thinking-label">
          {streaming ? `${verb}…` : "Thought"}
        </span>
        {streaming ? <BlinkingCursor /> : null}
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="thinking-body">
          <pre className="thinking-text">{text}</pre>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Inline tool-call indicators ---------- */

/** Walk the message's tool calls in order and break them into runs of
 * contiguous calls that share a `serverName`. Each run becomes either a
 * single inline row (one success → looks identical to before) or a
 * collapsible group with a one-line summary header — the new default once
 * a message has multiple calls or a retry pattern.
 *
 * The whole block also auto-collapses once the message stops streaming,
 * mirroring Claude Code: tool indicators are visible while the model is
 * working, then shrink to one summary line so the prose answer dominates.
 * Errors keep the block expanded so the user can see what failed. */
function ToolCallGroupList({
  calls,
  streaming,
}: {
  readonly calls: readonly ToolCallRecord[];
  readonly streaming: boolean;
}) {
  const groups = useMemo(() => groupCalls(calls), [calls]);
  const hasError = useMemo(
    () => calls.some((c) => effectiveStatus(c) === "error"),
    [calls],
  );

  // Open while streaming so the user watches calls land live; collapse on
  // the streaming → done transition unless an error needs surfacing. After
  // that, the user's manual toggles always win — including reopening on a
  // re-stream (rare, but happens for retried sends).
  const [open, setOpen] = useState<boolean>(streaming || hasError);
  const previouslyStreamingRef = useRef(streaming);
  useEffect(() => {
    if (previouslyStreamingRef.current && !streaming) {
      if (!hasError) setOpen(false);
    } else if (!previouslyStreamingRef.current && streaming) {
      setOpen(true);
    }
    previouslyStreamingRef.current = streaming;
  }, [streaming, hasError]);

  if (!open) {
    const totalMs = calls.reduce(
      (sum, c) => sum + (c.durationMs ?? 0),
      0,
    );
    const distinctTools = Array.from(new Set(calls.map((c) => c.toolName)));
    const label = `Used ${calls.length} tool${calls.length === 1 ? "" : "s"}`;
    return (
      <div className="tool-block tool-block-collapsed">
        <button
          type="button"
          className="tool-block-summary"
          onClick={() => setOpen(true)}
          aria-expanded={false}
        >
          <ToolStatusIcon status="complete" />
          <span className="tool-block-summary-label">{label}</span>
          <span className="tool-block-summary-tools">
            {distinctTools.join(" · ")}
          </span>
          {totalMs > 0 ? (
            <span className="tool-block-summary-duration">
              {formatDuration(totalMs)}
            </span>
          ) : null}
          <ChevronIcon open={false} />
        </button>
      </div>
    );
  }

  return (
    <div className="tool-block" role="list">
      {groups.map((group, idx) => {
        // A solo successful call stays inline — wrapping a single ✓ row in
        // a collapsible header would be more chrome than information. Any
        // error or any second call promotes the run to the group treatment.
        const promote = group.calls.length >= 2 || group.retries > 0;
        if (!promote) {
          const only = group.calls[0]!;
          return <ToolRow key={only.id || `${idx}:${only.toolName}`} call={only} />;
        }
        return (
          <ToolCallGroup
            key={`${group.serverName}:${idx}`}
            group={group}
            streaming={streaming}
          />
        );
      })}
    </div>
  );
}

interface CallGroup {
  /** The server every call in this group was routed to. Falls back to
   * "tools" when `serverName` was undefined (built-in tools or older
   * transcripts persisted before the field existed). */
  readonly serverName: string;
  readonly calls: readonly ToolCallRecord[];
  /** N consecutive errors followed by a success on the same tool name —
   * surfaced in the header as a `retried Nx` pill. */
  readonly retries: number;
  /** Sum of `durationMs` across every completed call in the group, in ms.
   * Errors with no duration contribute 0; the user reads it as
   * wall-clock-time-spent-in-tools, not request count. */
  readonly totalMs: number;
}

const FALLBACK_SERVER = "tools";

function groupCalls(calls: readonly ToolCallRecord[]): readonly CallGroup[] {
  const groups: CallGroup[] = [];
  let current: ToolCallRecord[] = [];
  let currentServer: string | undefined;
  const flush = () => {
    if (current.length === 0) return;
    groups.push(buildGroup(currentServer ?? FALLBACK_SERVER, current));
    current = [];
    currentServer = undefined;
  };
  for (const call of calls) {
    const server = call.serverName ?? FALLBACK_SERVER;
    if (currentServer !== undefined && server !== currentServer) {
      flush();
    }
    currentServer = server;
    current.push(call);
  }
  flush();
  return groups;
}

function buildGroup(
  serverName: string,
  calls: readonly ToolCallRecord[],
): CallGroup {
  let retries = 0;
  // Retry detection: walk the run, and for any consecutive `error → … →
  // ok` pattern on the same tool name, count the failures as retries. We
  // don't try to be clever about argument equality — same tool, same
  // server, error-then-success is the LLM-loop signature we want to
  // collapse, and accidentally combining unrelated errors is harmless
  // (the user can still expand the group to see them in detail).
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    if (effectiveStatus(call) !== "complete") continue;
    let back = i - 1;
    while (back >= 0) {
      const prior = calls[back]!;
      if (prior.toolName !== call.toolName) break;
      if (effectiveStatus(prior) !== "error") break;
      retries++;
      back--;
    }
  }
  let totalMs = 0;
  for (const call of calls) {
    if (typeof call.durationMs === "number") totalMs += call.durationMs;
  }
  return { serverName, calls, retries, totalMs };
}

function effectiveStatus(call: ToolCallRecord): ToolCallStatus {
  if (call.status) return call.status;
  if (call.isError) return "error";
  return "complete";
}

function ToolCallGroup({
  group,
  streaming,
}: {
  readonly group: CallGroup;
  readonly streaming: boolean;
}) {
  // Mirror the reasoning block: open while streaming so the user can see
  // every call land in real time, collapse the moment the message
  // finalizes. Manual toggles after that always win.
  const [open, setOpen] = useState<boolean>(streaming);
  const previouslyStreamingRef = useRef(streaming);
  useEffect(() => {
    if (previouslyStreamingRef.current && !streaming) {
      setOpen(false);
    } else if (!previouslyStreamingRef.current && streaming) {
      setOpen(true);
    }
    previouslyStreamingRef.current = streaming;
  }, [streaming]);

  const errorCount = group.calls.reduce(
    (n, c) => (effectiveStatus(c) === "error" ? n + 1 : n),
    0,
  );
  const running = group.calls.some((c) => effectiveStatus(c) === "running");
  const headerStatus: ToolCallStatus = running
    ? "running"
    : errorCount > 0
      ? "error"
      : "complete";
  // Distinct names rather than total count — the user wants to know
  // *what* the model called, not how many SQL retries happened (the
  // retry pill already covers that).
  const distinctTools = Array.from(
    new Set(group.calls.map((c) => c.toolName)),
  );

  return (
    <div className="tool-call-group" data-open={open || undefined}>
      <button
        type="button"
        className="tool-call-group-head"
        data-status={headerStatus}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ToolStatusIcon status={headerStatus} />
        <span className="tool-call-group-summary">
          <b>
            {group.calls.length} tool {group.calls.length === 1 ? "call" : "calls"}
          </b>
          <span className="tool-call-group-on">on</span>
          <span className="tool-call-group-server">{group.serverName}</span>
          {group.retries > 0 ? (
            <span className="tool-call-group-retry">
              retried {group.retries}×
            </span>
          ) : null}
          <span className="tool-call-group-tools">
            {distinctTools.join(" · ")}
          </span>
        </span>
        {group.totalMs > 0 ? (
          <span className="tool-call-group-duration">
            {formatDuration(group.totalMs)}
          </span>
        ) : null}
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="tool-call-group-body">
          {group.calls.map((call, idx) => (
            <ToolRow key={call.id || idx} call={call} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Memoized: rows re-render only when the specific call object identity
// changes. `patchCallRecords` upstream preserves identity for unchanged
// calls, so a settling tool doesn't drag every sibling row through a
// re-render — important when the model fans out 8+ parallel tool calls.
const ToolRow = memo(function ToolRow({ call }: { readonly call: ToolCallRecord }) {
  // Persist legacy records that have only `isError` (status was added
  // later) — derive a sensible status so older transcripts still render
  // with the right indicator.
  const status: ToolCallStatus = useMemo(() => {
    if (call.status) return call.status;
    if (call.isError) return "error";
    return "complete";
  }, [call.status, call.isError]);

  const capsuleStatus: "ok" | "run" | "err" =
    status === "running" ? "run" : status === "error" ? "err" : "ok";

  // Sub-agent dispatch gets its own header and body — task instead of
  // raw JSON args, an "Agent" badge so the user can tell this isn't a
  // plain tool call, and (when expanded) the sub-agent's own tool calls
  // rendered as nested ToolRows.
  if (call.toolName === "dispatch_agent") {
    return <AgentRow call={call} status={status} capsuleStatus={capsuleStatus} />;
  }

  return <PlainToolRow call={call} status={status} capsuleStatus={capsuleStatus} />;
});

function PlainToolRow({
  call,
  capsuleStatus,
}: {
  readonly call: ToolCallRecord;
  readonly status: ToolCallStatus;
  readonly capsuleStatus: "ok" | "run" | "err";
}) {
  const argsPreview = useMemo(
    () => previewLine(call.arguments, 100),
    [call.arguments],
  );
  const argsFull = useMemo(() => formatJsonish(call.arguments), [call.arguments]);
  const expandable = !!call.arguments && call.arguments.trim().length > 0;
  const [open, setOpen] = useState(false);

  return (
    <div className="tool-cap" data-status={capsuleStatus} role="listitem">
      <button
        type="button"
        className="tool-cap-head"
        onClick={() => (expandable ? setOpen((v) => !v) : undefined)}
        aria-expanded={expandable ? open : undefined}
        data-expandable={expandable || undefined}
      >
        <span className="tool-cap-dot" aria-hidden />
        <code className="tool-cap-tool">{call.toolName}</code>
        {call.serverName ? (
          <>
            <span className="tool-cap-sep" aria-hidden>·</span>
            <span className="tool-cap-server">{call.serverName}</span>
          </>
        ) : null}
        {argsPreview ? (
          <span className="tool-cap-args" title={argsPreview}>
            {argsPreview}
          </span>
        ) : (
          <span className="tool-cap-args" />
        )}
        {call.durationMs !== undefined ? (
          <span className="tool-cap-ms">{formatDuration(call.durationMs)}</span>
        ) : null}
        {expandable ? <ChevronIcon open={open} /> : null}
      </button>
      {expandable && open ? (
        <pre className="tool-cap-body">{argsFull}</pre>
      ) : null}
    </div>
  );
}

function AgentRow({
  call,
  capsuleStatus,
}: {
  readonly call: ToolCallRecord;
  readonly status: ToolCallStatus;
  readonly capsuleStatus: "ok" | "run" | "err";
}) {
  // Pull the task out of the dispatch_agent call's arguments so the
  // user sees what the sub-agent was asked to do, not raw JSON. Falls
  // back to a placeholder when the args were malformed (rare — useChat
  // rejects bad args before issuing the call).
  const { task, allowedTools } = useMemo(() => {
    if (!call.arguments) return { task: null, allowedTools: null };
    try {
      const parsed = JSON.parse(call.arguments) as {
        task?: unknown;
        allowed_tools?: unknown;
      };
      const t =
        typeof parsed.task === "string" && parsed.task.trim().length > 0
          ? parsed.task.trim()
          : null;
      const a = Array.isArray(parsed.allowed_tools)
        ? (parsed.allowed_tools.filter(
            (s): s is string => typeof s === "string",
          ) as string[])
        : null;
      return { task: t, allowedTools: a };
    } catch {
      return { task: null, allowedTools: null };
    }
  }, [call.arguments]);

  const nested = call.nestedCalls ?? [];
  const nestedRunning = nested.some(
    (n) => (n.status ?? (n.isError ? "error" : "complete")) === "running",
  );

  // Default open while the sub-agent is running so the user can watch
  // nested calls land. Once it settles we collapse to keep the
  // transcript tidy — manual toggles after that always win.
  const [open, setOpen] = useState<boolean>(capsuleStatus === "run");
  const wasRunningRef = useRef(capsuleStatus === "run");
  useEffect(() => {
    if (wasRunningRef.current && capsuleStatus !== "run") {
      // Keep open on error so the user can read what went wrong.
      if (capsuleStatus !== "err") setOpen(false);
    } else if (!wasRunningRef.current && capsuleStatus === "run") {
      setOpen(true);
    }
    wasRunningRef.current = capsuleStatus === "run";
  }, [capsuleStatus]);

  return (
    <div
      className="tool-cap tool-cap-agent"
      data-status={capsuleStatus}
      role="listitem"
    >
      <button
        type="button"
        className="tool-cap-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-expandable
      >
        <span className="tool-cap-dot" aria-hidden />
        <span className="tool-cap-agent-badge" aria-label="Sub-agent">
          Agent
        </span>
        <span className="tool-cap-agent-task" title={task ?? undefined}>
          {task ?? "(no task supplied)"}
        </span>
        {nested.length > 0 ? (
          <span className="tool-cap-agent-count" aria-label="nested tool calls">
            {nestedRunning
              ? `${nested.length} running`
              : `${nested.length} ${nested.length === 1 ? "call" : "calls"}`}
          </span>
        ) : null}
        {call.durationMs !== undefined ? (
          <span className="tool-cap-ms">{formatDuration(call.durationMs)}</span>
        ) : null}
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="tool-cap-agent-body">
          {allowedTools && allowedTools.length > 0 ? (
            <div className="tool-cap-agent-meta">
              <span className="tool-cap-agent-meta-label">Allowed tools:</span>
              <code className="tool-cap-agent-meta-value">
                {allowedTools.join(", ")}
              </code>
            </div>
          ) : null}
          {nested.length > 0 ? (
            <div className="tool-cap-agent-nested" role="list">
              <div className="tool-cap-agent-nested-label">
                Sub-agent tool calls
              </div>
              {nested.map((nc, idx) => (
                <ToolRow key={nc.id || idx} call={nc} />
              ))}
            </div>
          ) : capsuleStatus === "run" ? (
            <div className="tool-cap-agent-empty">Sub-agent thinking…</div>
          ) : null}
          {call.result && capsuleStatus !== "run" ? (
            <pre className="tool-cap-body tool-cap-agent-result">
              {call.result}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Pretty-print a serialized JSON-ish argument blob. Unparseable input
 * returns as-is so non-JSON tool inputs (raw strings, shell args) still
 * render legibly inside the expanded capsule. */
function formatJsonish(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function ToolStatusIcon({ status }: { readonly status: ToolCallStatus }) {
  if (status === "running") {
    return <span className="tool-status-spin" aria-hidden />;
  }
  if (status === "error") {
    return (
      <svg
        className="tool-status-icon"
        data-status="error"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </svg>
    );
  }
  return (
    <svg
      className="tool-status-icon"
      data-status="complete"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { readonly open: boolean }) {
  return (
    <svg
      className="tool-card-chevron"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        transform: open ? "rotate(180deg)" : undefined,
        transition: "transform 140ms ease",
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Build a single-line snippet of an argument blob for the collapsed head.
 * Keeps quotes/braces/colons (so the user can still read it as JSON-ish) but
 * collapses whitespace and truncates with an ellipsis. */
function previewLine(raw: string, max: number): string {
  if (!raw) return "";
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}
