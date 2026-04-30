import { useCallback, useEffect, useRef, useState } from "react";
import type OpenAI from "openai";
import { buildExtraBody, createClient } from "../lib/llm/client";
import type { ProviderConfig } from "../features/providers";
import type { TranscriptMessage } from "../app/types";

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ChatToolMessage =
  OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
type AssistantMessage =
  OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

/** Maximum tool-call iterations before we abandon the loop. Defends against
 * a misbehaving model that keeps re-issuing the same tool call without ever
 * emitting a final assistant message. */
const MAX_TOOL_ITERATIONS = 8;

/** OpenAI's function-name limit. Names also must match `[A-Za-z0-9_-]+`. */
const TOOL_NAME_MAX_LEN = 64;

export interface McpToolBinding {
  readonly serverId: string;
  readonly toolName: string;
  readonly description?: string;
  /** JSONSchema describing the tool's arguments. Forwarded to the LLM as
   * `function.parameters`. Falls back to an empty object schema when the
   * server didn't advertise one. */
  readonly inputSchema?: unknown;
}

export interface ChatExtras {
  /** Hidden system messages prepended to the API call. Used to inject MCP
   * prompt and resource content the user selected from the composer menu —
   * the model sees them, the user doesn't. Cleared by the caller after
   * each send (one-shot injection). */
  readonly systemContext?: readonly string[];
  /** MCP tools the model is allowed to call this turn. The hook runs the
   * tool-call loop internally and never adds tool exchange to the transcript;
   * only the final assistant text is rendered. */
  readonly mcpTools?: readonly McpToolBinding[];
}

export interface UseChatOptions {
  readonly provider: ProviderConfig | undefined;
  readonly messages: readonly TranscriptMessage[];
  readonly onMessagesChange: (next: readonly TranscriptMessage[]) => void;
}

export interface UseChatResult {
  readonly isStreaming: boolean;
  readonly error: string | null;
  readonly send: (text: string, extras?: ChatExtras) => Promise<void>;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toApiMessage(m: TranscriptMessage): ChatMessageParam {
  return { role: m.role, content: m.content };
}

/** Replace any character OpenAI doesn't allow in a function name with `_`,
 * collapse runs, and trim leading / trailing underscores. */
function sanitizeForOpenAi(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Build the OpenAI tools array + reverse-lookup map for one send call.
 *
 * The naive `${serverId}__${toolName}` encoding blows OpenAI's 64-char
 * function-name limit because helix server ids are uuid-derived (~36 chars)
 * before any tool-name is appended. Instead, we mint a short alias per
 * unique server (`s0`, `s1`, …) for this send, prefix the tool name with
 * it, and stash the round-trip in a Map. The model still sees a readable
 * name — just `s0_read_file` instead of the raw `mcp_<uuid>__read_file`. */
function buildToolPayload(bindings: readonly McpToolBinding[]): {
  tools: readonly ChatTool[];
  resolve: (modelName: string) => McpToolBinding | undefined;
} {
  const serverAlias = new Map<string, string>();
  const nameToBinding = new Map<string, McpToolBinding>();
  const tools: ChatTool[] = [];

  for (const binding of bindings) {
    let alias = serverAlias.get(binding.serverId);
    if (alias === undefined) {
      alias = `s${serverAlias.size}`;
      serverAlias.set(binding.serverId, alias);
    }
    const prefix = `${alias}_`;
    const safeTool = sanitizeForOpenAi(binding.toolName) || "tool";
    // Truncate the tool portion so prefix + tool fits in 64 chars. Plenty
    // for any realistic tool name; the description carries the meaning.
    const room = TOOL_NAME_MAX_LEN - prefix.length;
    let candidate = `${prefix}${safeTool.slice(0, room)}`;

    // De-dupe within this send (same server may legally advertise the same
    // sanitized name twice if the original contained different non-ascii
    // characters that collapsed to the same form). Append a numeric suffix
    // until unique.
    let suffixIdx = 0;
    while (nameToBinding.has(candidate)) {
      const tag = `_${suffixIdx++}`;
      candidate = `${prefix}${safeTool.slice(0, room - tag.length)}${tag}`;
    }

    nameToBinding.set(candidate, binding);

    const params =
      binding.inputSchema && typeof binding.inputSchema === "object"
        ? (binding.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    tools.push({
      type: "function",
      function: {
        name: candidate,
        description: binding.description,
        parameters: params,
      },
    });
  }

  return {
    tools,
    resolve: (modelName) => nameToBinding.get(modelName),
  };
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Controlled chat hook — the caller owns `messages` (e.g. via useSessions),
 * we just emit updates through `onMessagesChange`. Streaming chunks land in
 * the caller's store on every patch so persistence happens transparently.
 *
 * When `extras.mcpTools` is non-empty the hook runs an LLM ↔ MCP tool-call
 * loop: each round may emit text and/or tool_calls; tool_calls are executed
 * via `window.helixApi.callMcpTool` and the results are fed back as
 * `role: "tool"` API messages. Only the final assistant text reaches the
 * transcript — the user never sees the tool exchange. */
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
    (
      mutator: (prev: readonly TranscriptMessage[]) => readonly TranscriptMessage[],
    ) => {
      const next = mutator(messagesRef.current);
      messagesRef.current = next;
      onChangeRef.current(next);
    },
    [],
  );

  const send = useCallback(
    async (text: string, extras?: ChatExtras) => {
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

      const transcriptHistory = [...messagesRef.current, userMsg];
      patch(() => [...transcriptHistory, assistantStub]);
      setIsStreaming(true);

      // Build the initial API-side message stack: hidden system context
      // first (prompts / resources the user selected), then the visible
      // transcript. The transcript-side `messagesRef` never sees the system
      // context — it stays a property of this single send invocation.
      const apiMessages: ChatMessageParam[] = [];
      if (extras?.systemContext?.length) {
        for (const ctx of extras.systemContext) {
          if (ctx.trim().length > 0) {
            apiMessages.push({ role: "system", content: ctx });
          }
        }
      }
      apiMessages.push(...transcriptHistory.map(toApiMessage));

      const { tools, resolve: resolveTool } = buildToolPayload(
        extras?.mcpTools ?? [],
      );

      // True while we're inside a tool-loop iteration that has at least one
      // tool_call delta. We use it to gate transcript streaming: text that
      // precedes a tool call (e.g. "Let me check that…") is hidden, while
      // text from an iteration that turns out to be the final response is
      // streamed live.
      try {
        const client = createClient(provider);
        let finalContent = "";

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          const stream = await client.chat.completions.create({
            model: provider.model,
            messages: apiMessages,
            tools: tools.length > 0 ? (tools as ChatTool[]) : undefined,
            tool_choice: tools.length > 0 ? "auto" : undefined,
            stream: true,
            ...buildExtraBody(provider),
          });

          let acc = "";
          const toolCalls: AccumulatedToolCall[] = [];
          let finishReason: string | null = null;
          let liveStreamed = false;

          for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta as
              | {
                  content?: string | null;
                  tool_calls?: ReadonlyArray<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                }
              | undefined;

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let entry = toolCalls[idx];
                if (!entry) {
                  entry = { id: "", name: "", arguments: "" };
                  toolCalls[idx] = entry;
                }
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) {
                  entry.arguments += tc.function.arguments;
                }
              }
            }

            if (delta?.content) {
              acc += delta.content;
              // Stream content live only when we're confident the iteration
              // won't end with tool_calls — namely when the model started by
              // emitting plain text and hasn't requested any tool yet. If a
              // tool_call delta arrives later, we revert to hidden mode.
              if (toolCalls.length === 0) {
                liveStreamed = true;
                const snapshot = acc;
                patch((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: snapshot } : m,
                  ),
                );
              } else if (liveStreamed) {
                // A tool_call started after we'd already streamed text —
                // hide the prefix; it'll be replaced by the post-tool
                // response when the loop continues.
                liveStreamed = false;
                patch((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: "" } : m,
                  ),
                );
              }
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
          }

          // Post-stream: branch on whether the model wants more tool calls.
          if (finishReason === "tool_calls" && toolCalls.length > 0) {
            // Round-trip the assistant tool_calls + tool results without
            // touching the transcript. The user only sees the final
            // post-tool response.
            const assistantTurn: AssistantMessage = {
              role: "assistant",
              content: acc || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id || newId("call"),
                type: "function",
                function: { name: tc.name, arguments: tc.arguments || "{}" },
              })),
            };
            apiMessages.push(assistantTurn);

            for (const tc of toolCalls) {
              const binding = resolveTool(tc.name);
              let toolResult: string;
              if (!binding) {
                toolResult = `Tool "${tc.name}" is not addressable from helix.`;
              } else {
                let args: Record<string, unknown> = {};
                try {
                  args = tc.arguments ? JSON.parse(tc.arguments) : {};
                } catch (parseErr) {
                  toolResult = `Could not parse tool arguments: ${
                    parseErr instanceof Error
                      ? parseErr.message
                      : String(parseErr)
                  }`;
                  apiMessages.push({
                    role: "tool",
                    tool_call_id: tc.id || newId("call"),
                    content: toolResult,
                  } satisfies ChatToolMessage);
                  continue;
                }
                try {
                  const result = await window.helixApi.callMcpTool(
                    binding.serverId,
                    binding.toolName,
                    args,
                  );
                  toolResult = result.isError
                    ? `Tool error: ${result.content}`
                    : result.content;
                } catch (callErr) {
                  toolResult = `Tool call failed: ${
                    callErr instanceof Error ? callErr.message : String(callErr)
                  }`;
                }
              }
              apiMessages.push({
                role: "tool",
                tool_call_id: tc.id || newId("call"),
                content: toolResult,
              } satisfies ChatToolMessage);
            }
            // Loop back for the next iteration.
            continue;
          }

          // Terminal: this iteration's text is the final response.
          finalContent = acc;
          break;
        }

        patch((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: finalContent, status: "complete" }
              : m,
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
