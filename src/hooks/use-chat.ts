import { useCallback, useEffect, useRef, useState } from "react";
import { BUILTIN_SERVER_ID, runBuiltinTool } from "../lib/builtin-tools";
import { buildExtraBody, createClient } from "../lib/llm/client";
import { isReasoningModel } from "../lib/llm/model-traits";
import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
} from "../lib/llm/types";
import type { ProviderConfig } from "../features/providers";
import type { ToolCallRecord, TranscriptMessage } from "../app/types";

/** Maximum tool-call iterations before we abandon the loop. Defends against
 * a misbehaving model that keeps re-issuing the same tool call without ever
 * emitting a final assistant message. */
const MAX_TOOL_ITERATIONS = 8;

/** Default ceiling on completion tokens for non-reasoning models.
 * Overridable via the provider's extra_params, which merge in last. */
const DEFAULT_MAX_TOKENS = 8192;

/** Reasoning models (`o1*`, `o3*`, `o4*`, `gpt-5*`) burn a *lot* of tokens
 * internally before any visible output — a hard prompt on gpt-5 can chew
 * through 20-30K reasoning tokens with nothing user-facing yet, then 400
 * with "max_tokens reached". The legacy 8192 default starves them. Give
 * reasoning models 32K headroom by default; users can still override
 * via extra_params. */
const DEFAULT_REASONING_MAX_TOKENS = 32_768;


/** OpenAI's function-name limit. Names also must match `[A-Za-z0-9_-]+`.
 * Kept as the lowest common denominator across providers we target. */
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
  /** Per-send model override. Falls back to `provider.model` when omitted —
   * lets the composer's model switcher pick a model without mutating the
   * persisted provider config. */
  readonly model?: string;
}

export interface UseChatOptions {
  readonly provider: ProviderConfig | undefined;
  readonly messages: readonly TranscriptMessage[];
  readonly onMessagesChange: (next: readonly TranscriptMessage[]) => void;
  /** Context-reset boundary. Transcript messages with `createdAt` strictly
   * less than this timestamp stay visible to the user but are dropped from
   * the API-side message stack. Undefined means "send the full transcript",
   * matching the pre-feature behaviour. */
  readonly contextResetAt?: string;
}

export interface UseChatResult {
  readonly isStreaming: boolean;
  readonly error: string | null;
  readonly send: (text: string, extras?: ChatExtras) => Promise<void>;
  /** Abort the in-flight stream. The current assistant message stays in the
   * transcript with whatever content arrived before the stop; status flips
   * to "complete" so it renders normally. No-op when nothing is streaming. */
  readonly stop: () => void;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toApiMessage(m: TranscriptMessage): ChatMessage {
  return { role: m.role, content: m.content };
}

/** Replace any character that isn't allowed in a function name with `_`,
 * collapse runs, and trim leading / trailing underscores. */
function sanitizeToolName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Build the tools array + reverse-lookup map for one send call.
 *
 * The naive `${serverId}__${toolName}` encoding blows the 64-char function-
 * name limit because helix server ids are uuid-derived (~36 chars) before
 * any tool-name is appended. Instead, we mint a short alias per unique
 * server (`s0`, `s1`, …) for this send, prefix the tool name with it, and
 * stash the round-trip in a Map. The model still sees a readable name —
 * just `s0_read_file` instead of the raw `mcp_<uuid>__read_file`. */
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
    const safeTool = sanitizeToolName(binding.toolName) || "tool";
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

/** Pull every fenced ```vega-lite / vegalite / vega block (including the
 * fences) out of `text`. The transcript markdown plugin already maps these
 * languages to <VegaChart>; salvaging them from tool output means a chart
 * still renders even when the model decides to summarise the spec instead
 * of echoing it verbatim. */
const VEGA_BLOCK_RE = /```(?:vega-lite|vegalite|vega)\b[^\n]*\n[\s\S]*?\n```/g;
function extractVegaBlocks(text: string): string[] {
  if (!text || !text.includes("```")) return [];
  const out: string[] = [];
  let match: RegExpExecArray | null;
  // Reset state in case the regex (with /g) was used before.
  VEGA_BLOCK_RE.lastIndex = 0;
  while ((match = VEGA_BLOCK_RE.exec(text)) !== null) {
    out.push(match[0]);
  }
  return out;
}

/** Resolve and execute one tool call. Centralised so the agent loop above
 * doesn't have to thread the three failure paths (unknown tool, malformed
 * args, transport error) through nested branches. */
async function runToolCall(
  binding: McpToolBinding | undefined,
  rawName: string,
  rawArgs: string,
): Promise<{ result: string; isError: boolean }> {
  if (!binding) {
    return {
      result: `Tool "${rawName}" is not addressable from helix.`,
      isError: true,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (parseErr) {
    return {
      result: `Could not parse tool arguments: ${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`,
      isError: true,
    };
  }
  try {
    // Built-in tools (Read / Write / Edit / Glob / Grep) skip the MCP
    // transport entirely — they're plain Tauri commands. The dispatcher
    // already returns the same `{ result, isError }` shape so the agent
    // loop doesn't need to know which transport produced the result.
    if (binding.serverId === BUILTIN_SERVER_ID) {
      return await runBuiltinTool(binding.toolName, args);
    }
    const result = await window.helixApi.callMcpTool(
      binding.serverId,
      binding.toolName,
      args,
    );
    return {
      result: result.isError
        ? `Tool error: ${result.content}`
        : result.content,
      isError: result.isError,
    };
  } catch (callErr) {
    return {
      result: `Tool call failed: ${
        callErr instanceof Error ? callErr.message : String(callErr)
      }`,
      isError: true,
    };
  }
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
  const { provider, messages, onMessagesChange, contextResetAt } = options;
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so `send` can read the latest values without depending on them and
  // re-creating itself on every chunk (which would also re-render Composer).
  const messagesRef = useRef<readonly TranscriptMessage[]>(messages);
  const onChangeRef = useRef(onMessagesChange);
  const contextResetAtRef = useRef<string | undefined>(contextResetAt);
  // The AbortController controlling the active stream. Lives in a ref so the
  // stable `stop` callback can reach it without reattaching to every chunk.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    onChangeRef.current = onMessagesChange;
  }, [onMessagesChange]);
  useEffect(() => {
    contextResetAtRef.current = contextResetAt;
  }, [contextResetAt]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
      // The composer-side switcher can pick a model even when the provider
      // has no default; only error when neither is available.
      const chosenModel = extras?.model || provider.model;
      if (!chosenModel) {
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

      // One controller per send; `stop()` aborts it and the for-await loop
      // below exits via the catch arm.
      const ac = new AbortController();
      abortRef.current = ac;

      // Build the initial API-side message stack: hidden system context
      // first (prompts / resources the user selected), then the visible
      // transcript. The transcript-side `messagesRef` never sees the system
      // context — it stays a property of this single send invocation.
      // Honour the context-reset boundary: messages older than the cutoff
      // stay in the visible transcript but are dropped from the model-side
      // stack so the user can prune long sessions without losing scrollback.
      const apiMessages: ChatMessage[] = [];
      if (extras?.systemContext?.length) {
        for (const ctx of extras.systemContext) {
          if (ctx.trim().length > 0) {
            apiMessages.push({ role: "system", content: ctx });
          }
        }
      }
      const cutoff = contextResetAtRef.current;
      const sendableHistory = cutoff
        ? transcriptHistory.filter((m) => m.createdAt >= cutoff)
        : transcriptHistory;
      apiMessages.push(...sendableHistory.map(toApiMessage));

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
        // Recorded across every iteration of the loop and patched live into
        // the streaming assistant message so the transcript can render each
        // tool call as soon as the model commits to it. We mutate this array
        // in place and re-snapshot it (`[...callRecords]`) into the patch
        // closure so React sees a fresh reference per update.
        const callRecords: ToolCallRecord[] = [];
        // Reasoning text accumulated across every iteration — providers can
        // emit thinking before each tool call as well as before the final
        // response, so we keep one buffer per assistant message.
        let reasoningAcc = "";
        // Vega-Lite blocks salvaged from tool results — appended to the
        // assistant message at the end so charts render whether or not the
        // model echoes the spec.
        const harvestedCharts: string[] = [];

        const patchCallRecords = () => {
          const snapshot = callRecords.map((r) => ({ ...r }));
          patch((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, toolCalls: snapshot } : m,
            ),
          );
        };

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          if (ac.signal.aborted) break;
          // Reasoning models reject `max_tokens` and require
          // `max_completion_tokens`; they also need a much larger budget
          // because reasoning tokens are billed against the same cap.
          // Either is overridable via the provider's extra_params, which
          // merge in last and win.
          const reasoning = isReasoningModel(chosenModel);
          const tokenLimitField = reasoning
            ? "max_completion_tokens"
            : "max_tokens";
          const tokenLimit = reasoning
            ? DEFAULT_REASONING_MAX_TOKENS
            : DEFAULT_MAX_TOKENS;
          const stream = client.chatStream(
            {
              model: chosenModel,
              messages: apiMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? "auto" : undefined,
              [tokenLimitField]: tokenLimit,
              ...buildExtraBody(provider),
            },
            { signal: ac.signal },
          );

          let acc = "";
          const toolCalls: AccumulatedToolCall[] = [];
          let finishReason: string | null = null;
          let liveStreamed = false;

          for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta;

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

            // Reasoning tokens. Providers split on field name; coalesce into
            // one buffer and patch live so the Thinking block updates as the
            // model thinks.
            const reasoningDelta =
              delta?.reasoning_content ?? delta?.reasoning;
            if (reasoningDelta) {
              reasoningAcc += reasoningDelta;
              const snapshot = reasoningAcc;
              patch((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        reasoning: snapshot,
                        reasoningStatus: "streaming",
                      }
                    : m,
                ),
              );
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
            const dispatched = toolCalls.map((tc) => {
              const callId = tc.id || newId("call");
              const payload: ChatToolCall = {
                id: callId,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.arguments || "{}",
                },
              };
              return { tc, callId, payload };
            });
            apiMessages.push({
              role: "assistant",
              content: acc || null,
              tool_calls: dispatched.map((d) => d.payload),
            });

            // Push every call onto the transcript as "running" before we
            // dispatch them, so the UI shows them immediately. Each will be
            // patched in place below as the MCP server replies.
            const recordIndex = new Map<string, number>();
            for (const { tc, callId } of dispatched) {
              const binding = resolveTool(tc.name);
              recordIndex.set(callId, callRecords.length);
              callRecords.push({
                id: callId,
                serverId: binding?.serverId ?? "?",
                toolName: binding?.toolName ?? tc.name,
                arguments: tc.arguments || "{}",
                result: "",
                status: "running",
                isError: false,
              });
            }
            patchCallRecords();

            for (const { tc, callId } of dispatched) {
              const binding = resolveTool(tc.name);
              const startedAt = performance.now();
              const { result: toolResult, isError } = await runToolCall(
                binding,
                tc.name,
                tc.arguments,
              );
              if (!isError) {
                for (const block of extractVegaBlocks(toolResult)) {
                  harvestedCharts.push(block);
                }
              }
              const idx = recordIndex.get(callId);
              const existing = idx !== undefined ? callRecords[idx] : undefined;
              if (idx !== undefined && existing) {
                callRecords[idx] = {
                  ...existing,
                  result: toolResult,
                  status: isError ? "error" : "complete",
                  isError,
                  durationMs: Math.round(performance.now() - startedAt),
                };
                patchCallRecords();
              }
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: toolResult,
              });
            }
            // Loop back for the next iteration.
            continue;
          }

          // Terminal: this iteration's text is the final response.
          finalContent = acc;
          break;
        }

        // Append any vega-lite blocks we lifted out of tool results that
        // didn't make it into the model's final text. Dedupe by exact-string
        // match: if the model already echoed a spec, we won't duplicate it.
        if (harvestedCharts.length > 0) {
          const missing = harvestedCharts.filter(
            (block) => !finalContent.includes(block),
          );
          if (missing.length > 0) {
            const prefix = finalContent.trim();
            finalContent = prefix
              ? `${prefix}\n\n${missing.join("\n\n")}`
              : missing.join("\n\n");
          }
        }

        patch((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: finalContent,
                  status: "complete",
                  toolCalls:
                    callRecords.length > 0
                      ? callRecords.map((r) => ({ ...r }))
                      : undefined,
                  reasoning: reasoningAcc || undefined,
                  reasoningStatus: reasoningAcc ? "complete" : undefined,
                }
              : m,
          ),
        );
      } catch (err) {
        // User-initiated abort: keep whatever streamed in, mark complete.
        // Cleared assistant content gets a small placeholder so the row
        // doesn't render as a blank bubble.
        if (
          ac.signal.aborted ||
          (err as { name?: string } | null)?.name === "AbortError"
        ) {
          patch((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    status: "complete",
                    content: m.content || "_(stopped)_",
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    // Mark any still-running tool calls as errored so the
                    // UI stops the spinner.
                    toolCalls: m.toolCalls?.map((c) =>
                      c.status === "running"
                        ? {
                            ...c,
                            status: "error",
                            isError: true,
                            result: c.result || "(stopped)",
                          }
                        : c,
                    ),
                  }
                : m,
            ),
          );
        } else {
          const detail = err instanceof Error ? err.message : String(err);
          setError(detail);
          patch((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    status: "error",
                    content: m.content || `**Error:** ${detail}`,
                    reasoningStatus: m.reasoning ? "complete" : undefined,
                    toolCalls: m.toolCalls?.map((c) =>
                      c.status === "running"
                        ? {
                            ...c,
                            status: "error",
                            isError: true,
                            result: c.result || `(stream failed: ${detail})`,
                          }
                        : c,
                    ),
                  }
                : m,
            ),
          );
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [provider, isStreaming, patch],
  );

  return { isStreaming, error, send, stop };
}
