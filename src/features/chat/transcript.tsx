import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../components/markdown";
import type { ToolCallRecord, TranscriptMessage } from "../../app/types";

interface TranscriptProps {
  readonly messages: readonly TranscriptMessage[];
}

export function Transcript({ messages }: TranscriptProps) {
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

  return (
    <section className="transcript scroll">
      <div className="transcript-inner">
        {messages.map((msg) => (
          <MessageView key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function MessageView({ message }: { readonly message: TranscriptMessage }) {
  const streaming = message.status === "streaming";
  const toolCalls = message.toolCalls ?? [];
  const hasErrors = toolCalls.some((c) => c.isError);
  const [debugOpen, setDebugOpen] = useState(false);

  return (
    <div className="msg" data-status={message.status}>
      <div className="msg-role" data-role={message.role}>
        {message.role}
      </div>
      <div className="msg-content">
        {message.role === "assistant" ? (
          <Markdown content={message.content} streaming={streaming} />
        ) : (
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{message.content}</p>
        )}
        {message.role === "assistant" && toolCalls.length > 0 ? (
          <div className="msg-tool-debug">
            <button
              type="button"
              className="msg-tool-debug-toggle"
              data-open={debugOpen || undefined}
              data-has-errors={hasErrors || undefined}
              onClick={() => setDebugOpen((v) => !v)}
              aria-expanded={debugOpen}
              title={`${toolCalls.length} tool ${
                toolCalls.length === 1 ? "call" : "calls"
              } — click to inspect input/result`}
            >
              <WrenchIcon />
              <span>
                {toolCalls.length} tool{" "}
                {toolCalls.length === 1 ? "call" : "calls"}
              </span>
              {hasErrors ? (
                <span className="msg-tool-debug-error-dot" aria-label="some failed" />
              ) : null}
              <ChevronIcon open={debugOpen} />
            </button>
            {debugOpen ? <ToolCallList calls={toolCalls} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolCallList({ calls }: { readonly calls: readonly ToolCallRecord[] }) {
  return (
    <ol className="msg-tool-call-list">
      {calls.map((call, idx) => (
        <ToolCallEntry key={call.id} call={call} index={idx + 1} />
      ))}
    </ol>
  );
}

function ToolCallEntry({
  call,
  index,
}: {
  readonly call: ToolCallRecord;
  readonly index: number;
}) {
  return (
    <li className="msg-tool-call" data-error={call.isError || undefined}>
      <header className="msg-tool-call-head">
        <span className="msg-tool-call-index">#{index}</span>
        <code className="msg-tool-call-name">{call.toolName}</code>
        {call.isError ? (
          <span className="msg-tool-call-tag" data-tag="error">
            error
          </span>
        ) : null}
        {call.durationMs !== undefined ? (
          <span className="msg-tool-call-duration">{call.durationMs} ms</span>
        ) : null}
      </header>
      <div className="msg-tool-call-section">
        <span className="msg-tool-call-section-label">input</span>
        <pre className="msg-tool-call-section-body">
          {prettyJson(call.arguments)}
        </pre>
      </div>
      <div className="msg-tool-call-section">
        <span className="msg-tool-call-section-label">result</span>
        <pre className="msg-tool-call-section-body">{call.result || "(empty)"}</pre>
      </div>
    </li>
  );
}

function prettyJson(raw: string): string {
  if (!raw) return "{}";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function WrenchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.66 5.66l-7.04 7.04 2.83 2.83 7.04-7.04a4 4 0 0 0 5.66-5.66l-2.36 2.36-2.83-2.83z" />
    </svg>
  );
}

function ChevronIcon({ open }: { readonly open: boolean }) {
  return (
    <svg
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
