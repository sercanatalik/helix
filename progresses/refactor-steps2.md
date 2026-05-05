# Refactor Steps — Multi-Agent (`dispatch_agent`) Tool

## Summary of latest (uncommitted) changes

Adds a **`dispatch_agent` built-in tool** so the model can fan focused subtasks out to sub-agents that run their own tool-call loops in parallel, plus the **transcript UI** to surface sub-agent runs distinctly from regular tool calls.

| File | Change | Why |
|---|---|---|
| `src/lib/agent/sub-agent.ts` | **NEW** — self-contained `runSubAgent()` loop | Encapsulates a non-React tool-call loop reusable from `useChat`. Streams internally, returns one final string. Inherits parent's provider/model and a filtered tool subset. |
| `src/lib/builtin-tools/defs.ts` | Added `"agent"` group, `DISPATCH_AGENT_TOOL_NAME` constant, and `dispatch_agent` tool entry | Exposes the new capability through the same catalogue + popover machinery as the other built-in tools. |
| `src/lib/builtin-tools/dispatcher.ts` | Defensive `dispatch_agent` case in switch | The dispatcher API is `(name, args)` — no LLM client / tool list — so this branch only fires when the parent loop interceptor was bypassed (an internal bug). |
| `src/hooks/use-chat.ts` | Imports + `bindings` capture + `extraBody` hoist + `runDispatchAgent` helper + `Promise.all` interception | Detects `dispatch_agent` calls inside the existing parallel fan-out and routes them to `runSubAgent` with a filtered tool set. Sub-agents share the parent's `AbortController` so Stop unwinds everything. |
| `src/app/types.ts` | Added `nestedCalls?: readonly ToolCallRecord[]` to `ToolCallRecord` | Lets the transcript render the sub-agent's own tool calls live underneath the parent dispatch row. |
| `src/features/chat/transcript.tsx` | Split `ToolRow` into `PlainToolRow` (existing) + new `AgentRow` | Sub-agent dispatches get an "Agent" badge, the parsed task as primary label, a live "N running / N calls" pill, and a nested list of sub-agent tool calls when expanded. |
| `src/styles/components/chat.css` | Added `.tool-cap-agent*` styles | Accent-bordered capsule, badge, count pill, indented nested area — visually distinct from plain tool calls. |

---

## Implementation instructions for another LLM agent

> Goal: Apply seven edits (one new file, six modifications) to a clean checkout of the `helix` repo that already has the chat-streaming performance fixes from `refactor-steps1.md` applied. The end state is that the model can call `dispatch_agent` to spawn parallel sub-agents, and the transcript renders each sub-agent run with a distinct "Agent" capsule.
>
> Repo: `/Users/sercan/codebase/ai-works/helix`. Stack: Vite + React 18/19 + TypeScript + Tauri.
>
> Do NOT add comments, refactors, or "improvements" beyond what's specified. Each comment block in the instructions is part of the code to write — preserve wording exactly; the comments document *why* the code looks the way it does and are load-bearing for future maintainers.

### Step 0 — Preflight

1. `git status` should be clean. If not, stop and ask the user.
2. Read these files into context before editing — match existing style and surrounding code exactly:
   - `src/hooks/use-chat.ts` (the parent agent loop)
   - `src/lib/builtin-tools/defs.ts` (built-in tool catalogue)
   - `src/lib/builtin-tools/dispatcher.ts` (built-in tool router)
   - `src/lib/builtin-tools/index.ts` (barrel exports — confirm `BUILTIN_SERVER_ID` and `runBuiltinTool` are exported)
   - `src/lib/llm/client.ts` and `src/lib/llm/types.ts` (so the sub-agent module's types match)
   - `src/app/types.ts` (`ToolCallRecord`)
   - `src/features/chat/transcript.tsx` (existing `ToolRow`)
   - `src/styles/components/chat.css` (existing `.tool-cap*` styles end around line 1779)
3. Confirm the directory `src/lib/agent/` does **not** exist yet — Step 1 creates it.

---

### Step 1 — Create `src/lib/agent/sub-agent.ts`

```bash
mkdir -p src/lib/agent
```

Then write the new file with this exact content:

```ts
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
```

Why this shape:

- **Standalone module, no React** — sub-agents don't patch UI state directly; they emit progress through the optional `onProgress` callback. The parent owns React glue.
- **Inherits provider/model** — the parent already resolved `client`, `model`, `tokenLimitField`, `tokenLimit`, `extraBody`. We forward verbatim instead of re-resolving.
- **Mirrors the parent loop's shape** — same SSE accumulation, same `Promise.all` parallel tool dispatch, same iteration cap with a forced-synthesis fallback. Differences are deliberate: lower iteration cap (15 vs 25), smaller per-tool result cap (40KB vs 60KB), and no vega-chart harvesting.
- **Recursion is the caller's problem** — the file's header note and `tools` JSDoc make this explicit. `useChat` enforces it by filtering bindings.

---

### Step 2 — Edit `src/lib/builtin-tools/defs.ts`

Two distinct edits in this file.

#### 2a — Add `"agent"` to the group union and label map, plus the `DISPATCH_AGENT_TOOL_NAME` constant

Find the existing block:

```ts
/** Subgroups inside the Helix Core popover — mirror the MCP popover's
 * tag-bucket layout so each kind of capability gets its own master switch. */
export type BuiltinToolGroup = "file_system" | "data" | "web";

export const BUILTIN_GROUP_LABEL: Readonly<Record<BuiltinToolGroup, string>> = {
  file_system: "File System",
  data: "Data Tools",
  web: "Web",
};
```

Replace it with:

```ts
/** Subgroups inside the Helix Core popover — mirror the MCP popover's
 * tag-bucket layout so each kind of capability gets its own master switch. */
export type BuiltinToolGroup = "file_system" | "data" | "web" | "agent";

export const BUILTIN_GROUP_LABEL: Readonly<Record<BuiltinToolGroup, string>> = {
  file_system: "File System",
  data: "Data Tools",
  web: "Web",
  agent: "Agents",
};

/** Tool name the model uses to fan a focused subtask out to a sub-agent.
 * Exported so the agent loop can recognise it without string-matching
 * the literal in two places. */
export const DISPATCH_AGENT_TOOL_NAME = "dispatch_agent";
```

#### 2b — Insert the `dispatch_agent` tool entry into `BUILTIN_TOOLS`

Find the existing `web_fetch` entry — it begins with:

```ts
  {
    name: "web_fetch",
```

Insert this entry **immediately before** that one (so `dispatch_agent` lands between `web_search` and `web_fetch` in catalogue order, but it lives in its own `"agent"` group so the popover renders it under the "Agents" heading):

```ts
  {
    name: DISPATCH_AGENT_TOOL_NAME,
    label: "Dispatch Agent",
    group: "agent",
    description:
      "Spawn a sub-agent to accomplish a focused task in parallel with other work. The sub-agent runs an independent tool-call loop with the same model and a filtered subset of your tools, then returns one final answer as this tool's result. Use it to fan out independent investigations (e.g. 'profile module A' / 'profile module B' in parallel) or to keep a long, noisy exploration out of the main conversation. Issue several dispatch_agent calls in one turn to run them concurrently. Sub-agents cannot themselves call dispatch_agent (no recursion).",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Self-contained instructions for the sub-agent. Treat it like a brief to a smart colleague who has none of this conversation's context — describe the goal, constraints, and what \"done\" looks like. The sub-agent's reply becomes this tool's result.",
        },
        system_prompt: {
          type: "string",
          description:
            "Optional extra system prompt. Appended after the default sub-agent prompt — use it to scope the persona (e.g. 'You are a code reviewer focused on security') or impose constraints (e.g. 'Only inspect files under src/auth').",
        },
        allowed_tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional whitelist of tool names the sub-agent may call. Names are matched against the parent's tools (e.g. read_file, grep_search). Omit to grant every tool the parent has access to (minus dispatch_agent itself, which is always filtered to prevent recursion).",
        },
      },
      required: ["task"],
    },
  },
```

---

### Step 3 — Edit `src/lib/builtin-tools/dispatcher.ts`

Add a defensive `dispatch_agent` case to the switch statement. The dispatcher has no LLM client / tools list, so `dispatch_agent` is always intercepted by `useChat` upstream — reaching this branch is an internal-wiring bug that should surface, not silently succeed.

Find the existing `default` case at the bottom of the switch in `runBuiltinTool`:

```ts
      default:
        return {
          result: `Unknown built-in tool: ${name}`,
          isError: true,
        };
```

Replace it with:

```ts
      case "dispatch_agent":
        // Sub-agent dispatch needs the parent's LLM client and tool set,
        // neither of which the (name, args)-only dispatcher has access to.
        // `useChat` intercepts the call inside its tool fan-out; reaching
        // this branch means the interceptor missed the call — surface an
        // error rather than silently returning success with nothing.
        return {
          result:
            "dispatch_agent must be intercepted by the parent agent loop and was not — this indicates an internal wiring bug.",
          isError: true,
        };
      default:
        return {
          result: `Unknown built-in tool: ${name}`,
          isError: true,
        };
```

---

### Step 4 — Edit `src/app/types.ts`

Extend `ToolCallRecord` so the parent dispatch row can carry the sub-agent's nested call records.

Find the existing closing of the `ToolCallRecord` interface — it ends with:

```ts
  readonly isError: boolean;
  readonly durationMs?: number;
}
```

Replace those three lines with:

```ts
  readonly isError: boolean;
  readonly durationMs?: number;
  /** When this call is a sub-agent dispatch (`dispatch_agent`), the
   * sub-agent's own tool calls in execution order. Patched live as the
   * sub-agent streams so the user can watch the nested run unfold.
   * Undefined for ordinary tool calls; never set on the nested records
   * themselves (depth-1 only). */
  readonly nestedCalls?: readonly ToolCallRecord[];
}
```

---

### Step 5 — Edit `src/hooks/use-chat.ts`

Four distinct edits in this file.

#### 5a — Add imports at the top

Find the existing imports block (lines 1–11). Insert two new import lines so the block becomes:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { BUILTIN_SERVER_ID, runBuiltinTool } from "../lib/builtin-tools";
import { DISPATCH_AGENT_TOOL_NAME } from "../lib/builtin-tools/defs";
import { runSubAgent } from "../lib/agent/sub-agent";
import { buildExtraBody, createClient } from "../lib/llm/client";
import { isReasoningModel } from "../lib/llm/model-traits";
import type {
  ChatMessage,
  ChatTool,
  ChatToolCall,
} from "../lib/llm/types";
import type { ProviderConfig } from "../features/providers";
import type { ToolCallRecord, TranscriptMessage } from "../app/types";
```

The two new lines (lines 3 and 4 above) sit between the existing built-in-tools import and the LLM client import.

#### 5b — Capture `bindings` from `extras` so the dispatch helper can re-derive

Find the existing block that builds the tool payload (around line 434–437):

```ts
      const apiMessages: ChatMessage[] = [];
      const { tools, resolve: resolveTool } = buildToolPayload(
        extras?.mcpTools ?? [],
      );
```

Replace with:

```ts
      const apiMessages: ChatMessage[] = [];
      // Hold the original (unaliased) bindings list so the sub-agent
      // dispatch helper below can re-derive a filtered tool payload for
      // a sub-agent without re-plumbing through the composer.
      const bindings = extras?.mcpTools ?? [];
      const { tools, resolve: resolveTool } = buildToolPayload(bindings);
```

#### 5c — Add `extraBody` hoist + `runDispatchAgent` helper

Find the existing comment block that begins:

```ts
        // Signatures of the previous round's tool calls. We append a
        // hint to any result whose `(name, args)` matches a call from
        // the immediately-preceding round, nudging the model to vary
        // its arguments instead of looping on the same lookup.
        let lastCallSignatures = new Set<string>();
```

Insert the following block **immediately before** that comment (so `extraBody` and `runDispatchAgent` are in scope when the iteration loop runs below):

```ts
        // Cached extra-body for sub-agent dispatch (provider extras +
        // body-mode auth). Hoisted out of the helper so we don't rebuild
        // it on every dispatch_agent call.
        const extraBody = buildExtraBody(provider);

        // Run a sub-agent for one `dispatch_agent` tool call. The sub-
        // agent's tool list is the parent's bindings minus dispatch_agent
        // itself (depth-1; no recursion) and, when supplied, restricted
        // to the model-named `allowed_tools`. Returns the same
        // `{ result, isError }` shape as `runToolCall` so the dispatch
        // fan-out below stays uniform.
        const runDispatchAgent = async (
          rawArgs: string,
          onProgress?: (records: readonly ToolCallRecord[]) => void,
        ): Promise<{ result: string; isError: boolean }> => {
          let parsed: {
            task?: unknown;
            system_prompt?: unknown;
            allowed_tools?: unknown;
          };
          try {
            parsed = rawArgs ? JSON.parse(rawArgs) : {};
          } catch (parseErr) {
            return {
              result: `dispatch_agent: invalid JSON arguments: ${
                parseErr instanceof Error ? parseErr.message : String(parseErr)
              }`,
              isError: true,
            };
          }
          const task =
            typeof parsed.task === "string" ? parsed.task.trim() : "";
          if (!task) {
            return {
              result: "dispatch_agent: missing required `task` string.",
              isError: true,
            };
          }
          const systemPrompt =
            typeof parsed.system_prompt === "string"
              ? parsed.system_prompt
              : undefined;
          const allowed = Array.isArray(parsed.allowed_tools)
            ? (parsed.allowed_tools.filter(
                (s): s is string => typeof s === "string" && s.length > 0,
              ) as string[])
            : null;

          // Filter the parent's bindings: drop `dispatch_agent` (no
          // recursion) and, when an allow-list was supplied, intersect
          // by binding.toolName so the model can scope by the names it
          // sees in tool descriptions, not the aliased model-facing ids.
          const subBindings = bindings.filter((b) => {
            if (
              b.serverId === BUILTIN_SERVER_ID &&
              b.toolName === DISPATCH_AGENT_TOOL_NAME
            ) {
              return false;
            }
            if (allowed && !allowed.includes(b.toolName)) return false;
            return true;
          });
          if (subBindings.length === 0) {
            return {
              result:
                "dispatch_agent: no tools available to the sub-agent. Either widen `allowed_tools` or enable more tools in the parent.",
              isError: true,
            };
          }
          const { tools: subTools, resolve: subResolve } =
            buildToolPayload(subBindings);

          try {
            const r = await runSubAgent({
              client,
              model: chosenModel,
              tokenLimitField,
              tokenLimit,
              extraBody,
              tools: subTools,
              resolveTool: subResolve,
              task,
              systemPrompt,
              signal: ac.signal,
              onProgress,
            });
            const text = r.finalContent.trim();
            if (r.aborted) {
              return {
                result: text || "(sub-agent stopped before producing an answer)",
                isError: false,
              };
            }
            if (!text) {
              return {
                result:
                  "(sub-agent finished without returning any text — try a more specific task or check that the allowed tools can actually answer it)",
                isError: true,
              };
            }
            const note = r.budgetExhausted
              ? "\n\n[note] Sub-agent hit its tool-call budget — the answer above is a synthesis from partial evidence."
              : "";
            return { result: `${text}${note}`, isError: false };
          } catch (err) {
            return {
              result: `Sub-agent failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              isError: true,
            };
          }
        };

```

(Note the trailing blank line — keep it so there's a visual separator before the `lastCallSignatures` comment.)

#### 5d — Intercept `dispatch_agent` inside the `Promise.all` fan-out

Find the existing block inside the iteration loop where each tool call is dispatched (around the `settled = await Promise.all(...)` call):

```ts
            const settled = await Promise.all(
              dispatched.map(async ({ tc, callId }) => {
                const binding = resolveTool(tc.name);
                const startedAt = performance.now();
                const { result: rawResult, isError } = await runToolCall(
                  binding,
                  tc.name,
                  tc.arguments,
                );
```

Replace with:

```ts
            const settled = await Promise.all(
              dispatched.map(async ({ tc, callId }) => {
                const binding = resolveTool(tc.name);
                const isDispatchAgent =
                  binding?.serverId === BUILTIN_SERVER_ID &&
                  binding.toolName === DISPATCH_AGENT_TOOL_NAME;
                const startedAt = performance.now();
                const { result: rawResult, isError } = isDispatchAgent
                  ? await runDispatchAgent(tc.arguments, (nested) => {
                      // Patch the parent dispatch_agent record with the
                      // sub-agent's live tool-call snapshot so the
                      // transcript can render the nested run as it
                      // happens. We mutate the record at its known
                      // index — Promise.all's parallel map siblings
                      // touch their own indices, so there's no race.
                      const idx = recordIndex.get(callId);
                      if (idx !== undefined && callRecords[idx]) {
                        callRecords[idx] = {
                          ...callRecords[idx]!,
                          nestedCalls: nested,
                        };
                        patchCallRecords();
                      }
                    })
                  : await runToolCall(binding, tc.name, tc.arguments);
```

Leave the rest of the `Promise.all` map body unchanged — the existing recovery-hint / repeat-detection / record-patching code below this branch operates on `rawResult`/`isError` regardless of which path produced them.

---

### Step 6 — Edit `src/features/chat/transcript.tsx`

Replace the existing `ToolRow` definition with a thin dispatcher that branches on `dispatch_agent` and renders either `PlainToolRow` (the existing logic) or the new `AgentRow`.

The existing `ToolRow` (around line 540) currently reads:

```tsx
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
});
```

Replace **the entire memoised function** (header comment included) with:

```tsx
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
```

The existing imports at the top (`Fragment, memo, useEffect, useMemo, useRef, useState` from `react`; `ToolCallRecord, ToolCallStatus, TranscriptMessage` from `../../app/types`) already cover everything `AgentRow` needs — no import additions required.

---

### Step 7 — Edit `src/styles/components/chat.css`

Append the agent-capsule styles. Find the existing pulse keyframes block:

```css
@keyframes helix-toolcap-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
```

Insert this block **immediately after** that keyframes block (before the next `.tool-status-icon` rule):

```css

/* ---------- Sub-agent dispatch (dispatch_agent) ----------
 * The agent capsule reuses .tool-cap so layout, status colors, and
 * pulse animation stay consistent with regular tool calls. The
 * additional accent border, "Agent" badge, and nested-row indent are
 * all the user needs to recognise that this row is a multi-agent fan-out
 * and not a single tool call. */
.tool-cap-agent {
  border-color: color-mix(in oklab, var(--accent-raw) 32%, var(--border-subtle));
  background: color-mix(in oklab, var(--accent-raw) 4%, var(--bg-elev));
}
.tool-cap-agent[data-status="run"] {
  border-color: color-mix(in oklab, var(--accent-raw) 55%, var(--border-subtle));
}
.tool-cap-agent .tool-cap-dot {
  background: var(--accent-raw);
}
.tool-cap-agent[data-status="run"] .tool-cap-dot {
  background: var(--accent-raw);
}
.tool-cap-agent-badge {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--accent-raw) 18%, transparent);
  color: var(--accent-raw);
  flex-shrink: 0;
}
.tool-cap-agent-task {
  font-size: 12px;
  color: var(--fg);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.tool-cap-agent-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-dim);
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--accent-raw) 8%, transparent);
}
.tool-cap-agent[data-status="run"] .tool-cap-agent-count {
  color: var(--warn);
  background: color-mix(in oklab, var(--warn) 12%, transparent);
}
.tool-cap-agent-body {
  border-top: 1px solid var(--border-subtle);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-cap-agent-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-dim);
}
.tool-cap-agent-meta-label {
  flex-shrink: 0;
}
.tool-cap-agent-meta-value {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-muted);
  word-break: break-word;
}
.tool-cap-agent-nested {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 10px;
  border-left: 2px solid color-mix(in oklab, var(--accent-raw) 30%, transparent);
}
.tool-cap-agent-nested-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--fg-dim);
  margin-bottom: 2px;
}
.tool-cap-agent-empty {
  font-style: italic;
  font-size: 11.5px;
  color: var(--fg-dim);
  padding: 4px 0;
}
.tool-cap-agent-result {
  margin-top: 4px;
}
```

---

### Step 8 — Verify

Run, in order:

```bash
npm run typecheck
npm run build
```

Both must complete with **no errors**. The build emits the usual chunked output ending with `✓ built in <time>`. There is no test suite — manual verification in the dev server is the next step.

---

## Manual smoke test (post-merge)

1. `npm run tauri:dev` (or `npm run dev` for browser-only testing without Tauri APIs).
2. Open chat, attach a provider that supports parallel tool calls (OpenAI gpt-4o, Anthropic Claude 4.6+, etc.).
3. Open the built-in tools popover — verify a new **"Agents"** group appears with `dispatch_agent` enabled by default.
4. Send a prompt that should fan out — e.g. *"Use two sub-agents in parallel to (a) list every TypeScript file under src/hooks and (b) list every TypeScript file under src/features. Summarise the counts."*
5. Expected behaviour:
   - Two **accent-bordered "Agent" capsules** appear in the transcript, each showing the parsed task as the primary label.
   - The `N running` / `N calls` count pill ticks up as each sub-agent issues tool calls; the pill is amber while running, neutral when complete.
   - Each capsule auto-expands while running, showing the sub-agent's nested `read_file` / `glob_files` / etc. as standard `tool-cap` rows indented under a left accent border.
   - When the sub-agents finish, capsules auto-collapse (errors stay open). Click to re-open and see the sub-agent's final answer in the body.
   - Clicking **Stop** on the parent halts everything — sub-agents abort at the next round-trip via the shared `AbortController`.
6. Sanity-check no recursion: the sub-agent's nested rows must never themselves be `dispatch_agent` — the `useChat` filter strips it from `subBindings` before the sub-agent is spawned.

---

## Behavioural notes for future reviewers

- **Concurrency model:** Multiple `dispatch_agent` calls in one assistant turn run inside the same `Promise.all` as regular tool calls — sub-agents fan out automatically without additional plumbing.
- **Token cost:** Each sub-agent has its own message stack (system prompt + task + tool-result history). Costs multiply by the number of sub-agents per turn. The 15-iteration / 40KB-per-result caps are deliberately tighter than the parent's 25 / 60KB to keep that multiplication bounded.
- **Recursion:** Strictly depth-1. Enforced by `useChat` filtering `dispatch_agent` out of `subBindings`. The sub-agent module's docstring calls this contract out so future callers don't break it by relaxing the filter.
- **Abort semantics:** Sub-agents share the parent's `AbortController.signal`. A user-initiated stop unwinds every active sub-agent at its next `for await` boundary; in-flight tool calls finish but no further iterations occur.
- **UI deferred work (not in this batch):**
  - The "context-usage" chip in the composer doesn't account for sub-agent token spend (it's ephemeral).
  - The collapsed `tool-block` summary at the top of an assistant message counts a `dispatch_agent` row as one tool — fine for v1, but a richer summary could surface "+N nested calls".
  - No persistence schema migration: `nestedCalls` is optional and absent from older transcripts, which is exactly what you want for backwards compatibility.
