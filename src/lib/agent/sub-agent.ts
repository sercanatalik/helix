/* helix-ai · sub-agent runner.
 *
 * Powers the `dispatch_agent` built-in tool: a self-contained LLM ↔ tool
 * loop spawned from inside the parent agent's tool dispatch. The parent
 * `useChat` loop does the React glue (live patching, abort wiring) and
 * spawns a sub-agent here when the model emits a `dispatch_agent` call;
 * the sub-agent runs invisibly and returns one string — its final answer —
 * which the parent feeds back as the `tool` result for that call.
 *
 * Why a separate module from `useChat`? The parent loop streams content,
 * reasoning, and tool-call records straight into React state via rAF-
 * coalesced patches; sub-agents don't need any of that. Keeping the
 * sub-agent runner standalone avoids threading optional UI hooks through
 * the parent's hot path and keeps the recursion guard surface small.
 *
 * Recursion: depth-1 only. The caller must filter `dispatch_agent` itself
 * out of the sub-agent's tool list — `runSubAgent` enforces nothing on
 * that front.
 */

import type { LLMClient } from "../llm/client";
import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
} from "../llm/types";
import type { ToolCallRecord } from "../../app/types";
import { BUILTIN_SERVER_ID, runBuiltinTool } from "../builtin-tools";

/** Caller-supplied resolver: same shape as the one `buildToolPayload`
 * produces in `useChat`. Maps an aliased model-facing tool name back to
 * the real binding so we know which server / Tauri command to invoke. */
export interface ToolBindingLike {
  readonly serverId: string;
  readonly toolName: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RunSubAgentOptions {
  /** Live LLM client, already wired with provider auth. Reused — building
   * a fresh one per sub-agent would re-allocate headers for nothing. */
  readonly client: LLMClient;
  /** Model id. Sub-agents inherit the parent's chosen model unless the
   * caller explicitly picks a different one — picking is the parent's
   * call, not ours. */
  readonly model: string;
  /** Token-limit field name and value. Reasoning models reject
   * `max_tokens` and need `max_completion_tokens` plus a much larger
   * budget; the parent already worked this out. */
  readonly tokenLimitField: "max_tokens" | "max_completion_tokens";
  readonly tokenLimit: number;
  /** Provider extras (extra_params + body-mode auth). Spread last into
   * the request so a buggy proxy that needs a flag override can still
   * apply it. */
  readonly extraBody?: Record<string, unknown>;

  /** Tools the sub-agent is allowed to call. Pre-aliased and de-duped by
   * the parent — we forward verbatim. The parent must filter
   * `dispatch_agent` itself out of this list to prevent recursion. */
  readonly tools: readonly ChatTool[];
  /** Same resolver the parent uses, restricted to the sub-agent's tool
   * subset. Returns `undefined` when the model hallucinates a name not in
   * `tools` — `runSubAgent` reports the mismatch back to the model so it
   * can recover. */
  readonly resolveTool: (modelName: string) => ToolBindingLike | undefined;

  /** Task the sub-agent should accomplish. Becomes the user message that
   * kicks off the conversation. */
  readonly task: string;
  /** Optional sub-agent system prompt prepended to the request. The
   * caller controls phrasing; we just forward it. */
  readonly systemPrompt?: string;

  /** Shared abort signal — usually the parent's `AbortController.signal`.
   * If the user clicks Stop the sub-agent unwinds at the next round-trip. */
  readonly signal: AbortSignal;

  /** Cap on tool-call iterations. Lower than the parent loop's by default
   * (sub-agents are scoped tasks, not open-ended exploration). */
  readonly maxIterations?: number;
  /** Cap on the size of any single tool result fed back to the sub-agent.
   * Same role as the parent's MAX_TOOL_RESULT_BYTES — keeps a runaway
   * web_fetch from blowing the sub-agent's context window. */
  readonly maxToolResultBytes?: number;

  /** Optional progress callback fired on every tool-call status change.
   * The parent uses this to keep its UI's nested view (when present)
   * up-to-date. Not load-bearing — the function still works without it. */
  readonly onProgress?: (records: readonly ToolCallRecord[]) => void;
}

export interface RunSubAgentResult {
  /** The sub-agent's final user-facing answer. Empty string when the
   * sub-agent aborted before producing any text. */
  readonly finalContent: string;
  /** Snapshot of every tool call the sub-agent issued, in execution
   * order. Surfaced so the parent can show a nested transcript later. */
  readonly callRecords: readonly ToolCallRecord[];
  /** True when the sub-agent hit its iteration cap without a synthesis. */
  readonly budgetExhausted: boolean;
  /** True when the sub-agent's loop exited because the shared abort
   * signal fired — distinguishes a user stop from a budget exhaustion. */
  readonly aborted: boolean;
}

const DEFAULT_MAX_ITERATIONS = 15;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 40_000;

/** System prompt the parent agent doesn't see. Nudges the sub-agent
 * toward focused, evidence-based answers since its output is the parent's
 * tool result, not user-facing prose. */
const SUB_AGENT_SYSTEM_PROMPT =
  "You are a sub-agent invoked by a parent agent to accomplish a focused task. " +
  "Use tools to gather concrete evidence, then return a direct answer to the task. " +
  "Your final reply will be handed back verbatim as the parent's tool result, so:\n" +
  "- Be concise and factual; skip preamble like \"Here is the answer\".\n" +
  "- If you ran tools, summarise what you found — don't dump raw output.\n" +
  "- If the task is impossible with the tools available, say so plainly.";

function newCallId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Same truncation strategy the parent uses; copied here so the sub-agent
 * doesn't reach into useChat internals. Keeping the head and tail means
 * structural framing survives — only the dense middle is elided. */
function capToolResult(s: string, maxBytes: number): string {
  if (s.length <= maxBytes) return s;
  const half = Math.floor((maxBytes - 200) / 2);
  const elided = s.length - 2 * half;
  return (
    `${s.slice(0, half)}\n\n` +
    `[… ${elided.toLocaleString()} bytes elided. Narrow the call to focus on the relevant section. …]\n\n` +
    `${s.slice(s.length - half)}`
  );
}

/** Resolve and execute a single tool call inside the sub-agent. Mirrors
 * the parent's `runToolCall` shape but only knows about the bindings the
 * caller passed in — no fall-through to a shared registry. */
async function runOne(
  binding: ToolBindingLike | undefined,
  rawName: string,
  rawArgs: string,
): Promise<{ result: string; isError: boolean }> {
  if (!binding) {
    return {
      result: `Tool "${rawName}" is not available to this sub-agent.`,
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

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Run a sub-agent to completion. The function streams the model
 * response internally so we can handle tool-call deltas, but no tokens
 * leak out — only the final aggregated answer is returned.
 *
 * Errors during streaming bubble up to the caller (which is itself inside
 * a `Promise.all` in the parent loop, so the parent will see a settled
 * promise with `isError: true`). */
export async function runSubAgent(
  opts: RunSubAgentOptions,
): Promise<RunSubAgentResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;

  // Build the sub-agent's own message stack. The parent's transcript and
  // hidden system context never reach the sub-agent — the only context
  // it has is the task string and (optionally) a caller-supplied system
  // prompt.
  const apiMessages: ChatMessage[] = [];
  if (opts.tools.length > 0) {
    apiMessages.push({ role: "system", content: SUB_AGENT_SYSTEM_PROMPT });
  }
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    apiMessages.push({ role: "system", content: opts.systemPrompt });
  }
  apiMessages.push({ role: "user", content: opts.task });

  const callRecords: ToolCallRecord[] = [];
  const recordIndexById = new Map<string, number>();
  const emitProgress = () => {
    if (!opts.onProgress) return;
    opts.onProgress(callRecords.map((r) => ({ ...r })));
  };

  let finalContent = "";
  let budgetExhausted = false;
  let normalExit = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.signal.aborted) break;

    const stream = opts.client.chatStream(
      {
        model: opts.model,
        messages: apiMessages,
        tools: opts.tools.length > 0 ? opts.tools : undefined,
        tool_choice: opts.tools.length > 0 ? "auto" : undefined,
        ...(opts.tools.length > 0 ? { parallel_tool_calls: true } : {}),
        [opts.tokenLimitField]: opts.tokenLimit,
        ...(opts.extraBody ?? {}),
      },
      { signal: opts.signal },
    );

    let acc = "";
    const toolCalls: AccumulatedToolCall[] = [];
    let finishReason: string | null = null;

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

      if (delta?.content) acc += delta.content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (finishReason === "tool_calls" && toolCalls.length > 0) {
      const dispatched = toolCalls.map((tc) => {
        const callId = tc.id || newCallId();
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

      for (const { tc, callId } of dispatched) {
        const binding = opts.resolveTool(tc.name);
        recordIndexById.set(callId, callRecords.length);
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
      emitProgress();

      const settled = await Promise.all(
        dispatched.map(async ({ tc, callId }) => {
          const binding = opts.resolveTool(tc.name);
          const startedAt = performance.now();
          const { result: rawResult, isError } = await runOne(
            binding,
            tc.name,
            tc.arguments,
          );
          const modelResult = capToolResult(rawResult, maxBytes);
          const durationMs = Math.round(performance.now() - startedAt);
          const idx = recordIndexById.get(callId);
          if (idx !== undefined && callRecords[idx]) {
            callRecords[idx] = {
              ...callRecords[idx]!,
              result: rawResult,
              status: isError ? "error" : "complete",
              isError,
              durationMs,
            };
          }
          return { callId, modelResult };
        }),
      );
      emitProgress();

      for (const { callId, modelResult } of settled) {
        apiMessages.push({
          role: "tool",
          tool_call_id: callId,
          content: modelResult,
        });
      }
      continue;
    }

    finalContent = acc;
    normalExit = true;
    break;
  }

  if (!normalExit && !opts.signal.aborted) {
    budgetExhausted = true;
    // Force a synthesis: the sub-agent's caller is going to feed our
    // text back as a tool result, so an empty string here produces a
    // useless "" tool-result. One last call with `tool_choice: "none"`
    // gets the model to summarise what it gathered.
    if (opts.tools.length > 0 && callRecords.length > 0) {
      apiMessages.push({
        role: "system",
        content:
          "Sub-agent tool-call budget reached. Synthesise a final answer for the parent agent from the evidence above. Do not request more tools.",
      });
      try {
        const stream = opts.client.chatStream(
          {
            model: opts.model,
            messages: apiMessages,
            tools: opts.tools,
            tool_choice: "none",
            [opts.tokenLimitField]: opts.tokenLimit,
            ...(opts.extraBody ?? {}),
          },
          { signal: opts.signal },
        );
        let acc = "";
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.delta?.content) acc += choice.delta.content;
        }
        if (acc.trim()) finalContent = acc;
      } catch {
        // Synthesis call failed — leave finalContent as whatever we had
        // and let the caller surface the budget-exhausted signal.
      }
    }
  }

  return {
    finalContent,
    callRecords: callRecords.map((r) => ({ ...r })),
    budgetExhausted,
    aborted: opts.signal.aborted,
  };
}
