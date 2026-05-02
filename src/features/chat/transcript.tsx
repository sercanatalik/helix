import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
  const dividerBeforeId = (() => {
    if (!contextResetAt) return null;
    const idx = messages.findIndex((m) => m.createdAt >= contextResetAt);
    if (idx <= 0) return null;
    return messages[idx]!.id;
  })();

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

function MessageView({ message, stale = false }: MessageViewProps) {
  const streaming = message.status === "streaming";
  const isAssistant = message.role === "assistant";
  // Tool rows are a streaming affordance — they show what the model is
  // doing while it works, then disappear once the response is finalized.
  // The result is folded into the assistant text the user actually reads.
  const toolCalls = streaming ? message.toolCalls ?? [] : [];
  const reasoning = message.reasoning ?? "";
  const reasoningStreaming =
    streaming && message.reasoningStatus !== "complete";
  const showStatusLine =
    isAssistant && streaming && !reasoning && toolCalls.length === 0;
  const verb = useRotatingVerb(isAssistant && streaming);

  return (
    <div
      className="msg"
      data-status={message.status}
      data-stale={stale ? "true" : undefined}
    >
      <div className="msg-role" data-role={message.role}>
        {message.role}
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
          <ToolCallsBlock calls={toolCalls} />
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
  );
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

/* Claude Code style: a flat, single-line row per tool call — status dot,
 * tool name, arg preview in parens, duration when done. No expand, no
 * artifact pane: the result is implicit (the model uses it to produce the
 * next text block). Errors flip the dot and tint the row. */
function ToolCallsBlock({
  calls,
}: {
  readonly calls: readonly ToolCallRecord[];
}) {
  return (
    <ul className="tool-block" role="list">
      {calls.map((call, idx) => (
        <ToolRow key={call.id || idx} call={call} />
      ))}
    </ul>
  );
}

function ToolRow({ call }: { readonly call: ToolCallRecord }) {
  // Persist legacy records that have only `isError` (status was added
  // later) — derive a sensible status so older transcripts still render
  // with the right indicator.
  const status: ToolCallStatus = useMemo(() => {
    if (call.status) return call.status;
    if (call.isError) return "error";
    return "complete";
  }, [call.status, call.isError]);

  const argsPreview = useMemo(
    () => previewLine(call.arguments, 100),
    [call.arguments],
  );

  return (
    <li className="tool-row" data-status={status}>
      <ToolStatusIcon status={status} />
      <code className="tool-row-name">{call.toolName}</code>
      {argsPreview ? (
        <span className="tool-row-args" title={argsPreview}>
          ({argsPreview})
        </span>
      ) : null}
      {status === "complete" && call.durationMs !== undefined ? (
        <span className="tool-row-duration">{formatDuration(call.durationMs)}</span>
      ) : null}
    </li>
  );
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
