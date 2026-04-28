import { useCallback, useEffect, useRef, useState } from "react";
import type OpenAI from "openai";
import { buildExtraBody, createClient } from "../lib/llm/client";
import type { ProviderConfig } from "../features/providers";
import type { TranscriptMessage } from "../app/types";

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface UseChatOptions {
  readonly provider: ProviderConfig | undefined;
  readonly messages: readonly TranscriptMessage[];
  readonly onMessagesChange: (next: readonly TranscriptMessage[]) => void;
}

export interface UseChatResult {
  readonly isStreaming: boolean;
  readonly error: string | null;
  readonly send: (text: string) => Promise<void>;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toApiMessage(m: TranscriptMessage): ChatMessageParam {
  // The three roles we use all accept a plain string content.
  return { role: m.role, content: m.content };
}

/** Controlled chat hook — the caller owns `messages` (e.g. via useSessions),
 * we just emit updates through `onMessagesChange`. Streaming chunks land in
 * the caller's store on every patch so persistence happens transparently. */
export function useChat(options: UseChatOptions): UseChatResult {
  const { provider, messages, onMessagesChange } = options;
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so `send` can read the latest values without depending on them and
  // re-creating itself on every chunk (which would also re-render Composer).
  const messagesRef = useRef<readonly TranscriptMessage[]>(messages);
  const onChangeRef = useRef(onMessagesChange);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    onChangeRef.current = onMessagesChange;
  }, [onMessagesChange]);

  const patch = useCallback(
    (mutator: (prev: readonly TranscriptMessage[]) => readonly TranscriptMessage[]) => {
      const next = mutator(messagesRef.current);
      messagesRef.current = next;
      onChangeRef.current(next);
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      if (!provider) {
        setError("No provider configured. Add one in Settings → Providers.");
        return;
      }
      if (!provider.model) {
        setError(`Provider "${provider.name}" has no default model set.`);
        return;
      }
      setError(null);

      const userMsg: TranscriptMessage = {
        id: newId("u"),
        role: "user",
        content: trimmed,
        createdAt: nowIso(),
        status: "complete",
      };
      const assistantId = newId("a");
      const assistantStub: TranscriptMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: nowIso(),
        status: "streaming",
      };

      const history = [...messagesRef.current, userMsg];
      patch(() => [...history, assistantStub]);
      setIsStreaming(true);

      try {
        const client = createClient(provider);
        const stream = await client.chat.completions.create({
          model: provider.model,
          messages: history.map(toApiMessage),
          stream: true,
          ...buildExtraBody(provider),
        });

        let acc = "";
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (!delta) continue;
          acc += delta;
          patch((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: acc } : m,
            ),
          );
        }
        patch((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, status: "complete" } : m,
          ),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(detail);
        patch((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  status: "error",
                  content: m.content || `**Error:** ${detail}`,
                }
              : m,
          ),
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [provider, isStreaming, patch],
  );

  return { isStreaming, error, send };
}
