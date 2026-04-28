import { useEffect, useRef } from "react";
import { Markdown } from "../../components/markdown";
import type { TranscriptMessage } from "../../app/types";

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
      </div>
    </div>
  );
}
