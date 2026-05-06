import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

/** Live progress payload emitted by the Rust side (`tool_progress.rs`).
 * Routed by call id to the in-flight tool record so the running row can
 * show "Connecting…" / "Downloading 240 KB" instead of a generic spinner. */
const TOOL_PROGRESS_EVENT = "helix://tool-progress";
interface ToolProgressPayload {
  readonly id: string;
  readonly label: string;
}

/** Module-level registry of "tool-call id → onProgress callback". Lazily
 * attaches a single `listen()` so we don't open a fresh subscription per
 * `useChat` mount or per send. The listener fan-outs by id and silently
 * drops events for ids no one's waiting on. Outside a Tauri runtime
 * (vite dev), `listen()` rejects — we swallow that and progress just
 * never fires, matching the rest of the app's degraded-mode behaviour. */
const toolProgressCallbacks = new Map<string, (label: string) => void>();
let toolProgressUnlisten: Promise<UnlistenFn> | undefined;
function ensureToolProgressListener(): void {
  if (toolProgressUnlisten) return;
  toolProgressUnlisten = listen<ToolProgressPayload>(
    TOOL_PROGRESS_EVENT,
    (event) => {
      const cb = toolProgressCallbacks.get(event.payload.id);
      if (cb) cb(event.payload.label);
    },
  ).catch((err) => {
    // Fall back to a no-op unlisten so we don't keep retrying. In a
    // non-Tauri env this is the expected path.
    void err;
    return () => {};
  });
}
function registerToolProgress(
  callId: string,
  cb: (label: string) => void,
): () => void {
  ensureToolProgressListener();
  toolProgressCallbacks.set(callId, cb);
  return () => {
    toolProgressCallbacks.delete(callId);
  };
}

/** Maximum tool-call iterations before we force a final answer. Aligned
 * with the under-12 guidance in TOOL_USE_SYSTEM_PROMPT so the prompt and
 * the runtime cap agree. With parallel_tool_calls each iteration can fan
 * out — that's the intended way to do breadth without burning the budget.
 * When we hit this cap we don't just bail — we issue one final call with
 * `tool_choice: "none"` so the user gets a synthesis from whatever
 * evidence was gathered instead of a blank message. */
const MAX_TOOL_ITERATIONS = 12;

/** Cap on the size of any single tool result we feed back to the model.
 * Past this, we elide the middle and tell the model to narrow the call.
 * Prevents a runaway grep / web_fetch from blowing the context window. The
 * UI transcript still shows the full untruncated result. */
const MAX_TOOL_RESULT_BYTES = 60_000;

/** Tool results from rounds older than this many iterations get demoted
 * to a one-line summary in the API stack so a long agent loop's context
 * doesn't grow unboundedly. The model can re-issue the call if it needs
 * the full data — usually it's already extracted what it needed. The
 * UI transcript keeps every result at full size so the user can audit. */
const TOOL_AGING_AFTER_ROUNDS = 3;
/** Don't bother summarising results below this size — the savings don't
 * justify hiding evidence the model might still glance at. Tuned roughly
 * to "one screenful of grep output". */
const TOOL_AGING_MIN_BYTES = 2000;

/** Hidden system message prepended whenever the request carries tools.
 * Nudges the model toward parallelism, deeper drilling, and graceful error
 * recovery — none of which a raw schema list communicates. User-supplied
 * `extras.systemContext` lands after this so it can override. */
const TOOL_USE_SYSTEM_PROMPT =
  "You have access to tools. Use them to gather concrete evidence before you answer — do not guess at file contents, search results, or web data.\n\n" +
  "Guidelines:\n" +
  "- Keep the total number of tool calls in your response under 12. Plan upfront which calls you actually need, and prefer one well-scoped call over several narrow ones.\n" +
  "- Issue independent tool calls in parallel in a single turn (e.g. reading several files, running multiple searches at once) instead of serializing them — parallel batches count as one round and are the cheapest way to stay under the 12-call budget.\n" +
  "- Before each new tool call, ask whether you already have enough evidence to answer; if yes, stop and write the response.\n" +
  "- If a tool returns truncated output, call it again with a wider window (offset, max_bytes, head_limit, larger limit) to read more — but widen aggressively so one retry is enough.\n" +
  "- If a tool fails, briefly note the failure and try a different approach — for example use glob_files or grep_search to locate a missing path, or web_search before web_fetch.\n" +
  "- Do not repeat an identical tool call you just made; if you need different data, change the arguments.\n" +
  "- For broad or multi-faceted exploration that would otherwise need many calls, use dispatch_agent to delegate it — the sub-agent's calls don't count toward your budget.";

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

/** Truncate a tool result that's larger than `MAX_TOOL_RESULT_BYTES`,
 * keeping the head and tail so structural framing (headers, summary lines,
 * trailing notes) survives. The middle is replaced with an explicit hint
 * the model can act on. Untouched if already under the cap. */
function capToolResultForModel(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_BYTES) return s;
  // Reserve ~200 chars for the elision marker; split the rest evenly.
  const half = Math.floor((MAX_TOOL_RESULT_BYTES - 200) / 2);
  const elided = s.length - 2 * half;
  return (
    `${s.slice(0, half)}\n\n` +
    `[… ${elided.toLocaleString()} bytes elided to keep context manageable. ` +
    `Narrow the call (path, glob, head_limit, max_bytes, offset+limit) to focus on the relevant section. …]\n\n` +
    `${s.slice(s.length - half)}`
  );
}

/** Inspect a tool failure message and return a one-liner the model can
 * actually use to recover. Returns null when no specific hint applies —
 * we don't want to bury legitimate errors under generic advice. */
function recoveryHintFor(toolName: string, errMessage: string): string | null {
  const e = errMessage.toLowerCase();
  if (/no such file|enoent|not found|cannot find|does not exist/.test(e)) {
    return "Use glob_files or grep_search to locate the correct path before retrying.";
  }
  if (/not unique|multiple occurrences/.test(e)) {
    return "Read the file first and supply a longer, unique excerpt as old_string — or set replace_all=true if you intend every occurrence.";
  }
  if (/could not parse|invalid json|json/.test(e) && /argument/.test(e)) {
    return "Re-emit the call with valid JSON arguments matching the tool's parameter schema.";
  }
  if (/timeout|timed out|deadline/.test(e)) {
    return "Narrow the scope (smaller glob, lower head_limit, smaller max_bytes) and try again.";
  }
  if (/non-2xx|status 4\d\d|status 5\d\d|http 4\d\d|http 5\d\d/.test(e)) {
    return toolName === "web_fetch"
      ? "The server rejected the request (consent wall / anti-bot / 5xx). Use web_search to find an alternative source or a JSON API endpoint."
      : "The remote rejected the request. Try a different source or endpoint.";
  }
  if (/missing/.test(e) && /required/.test(e)) {
    return "Add the missing required parameter and retry.";
  }
  return null;
}

/** Resolve and execute one tool call. Centralised so the agent loop above
 * doesn't have to thread the three failure paths (unknown tool, malformed
 * args, transport error) through nested branches. */
async function runToolCall(
  binding: McpToolBinding | undefined,
  rawName: string,
  rawArgs: string,
  progressId?: string,
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
      return await runBuiltinTool(binding.toolName, args, progressId);
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
  // Pending rAF handle for coalescing streaming patches. Tokens often arrive
  // faster than React can paint (100+/sec for some providers); without this
  // every chunk would trigger a transcript re-render plus a layout pass for
  // auto-scroll, and the in-flight tool/reasoning rows would re-render on
  // every keystroke of the model.
  const pendingFrameRef = useRef<number | null>(null);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    onChangeRef.current = onMessagesChange;
  }, [onMessagesChange]);
  useEffect(() => {
    contextResetAtRef.current = contextResetAt;
  }, [contextResetAt]);
  useEffect(() => {
    return () => {
      if (pendingFrameRef.current !== null) {
        cancelAnimationFrame(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Synchronously deliver the latest transcript and cancel any deferred
  // frame. Call before terminal state changes (stream end / abort / error)
  // so the user doesn't see `isStreaming: false` over a stale transcript.
  const flushPending = useCallback(() => {
    if (pendingFrameRef.current !== null) {
      cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
    onChangeRef.current(messagesRef.current);
  }, []);

  const patch = useCallback(
    (
      mutator: (prev: readonly TranscriptMessage[]) => readonly TranscriptMessage[],
    ) => {
      const next = mutator(messagesRef.current);
      messagesRef.current = next;
      // Update the ref synchronously so the next mutator sees the latest
      // state, but defer the React notification to the next frame to
      // collapse many chunks into a single render.
      if (pendingFrameRef.current !== null) return;
      pendingFrameRef.current = requestAnimationFrame(() => {
        pendingFrameRef.current = null;
        onChangeRef.current(messagesRef.current);
      });
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
        // Live until the first delta of any kind arrives — drives the
        // "Thinking…" indicator across HTTP wait time and the silent
        // gap between iterations.
        awaitingResponse: true,
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
      // Hold the original (unaliased) bindings list so the sub-agent
      // dispatch helper below can re-derive a filtered tool payload for
      // a sub-agent without re-plumbing through the composer.
      const bindings = extras?.mcpTools ?? [];
      const { tools, resolve: resolveTool } = buildToolPayload(bindings);
      // When the model gets tools this turn, prepend a brief usage policy.
      // Lands first so user-supplied systemContext can override specifics.
      if (tools.length > 0) {
        apiMessages.push({ role: "system", content: TOOL_USE_SYSTEM_PROMPT });
      }
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
        // Pre-tool-call text the model emitted across earlier iterations.
        // Each iteration that ends in tool_calls commits its acc here so
        // "Let me check the file…" preambles survive into the final
        // message instead of being wiped when the next iteration starts
        // with an empty buffer. The streaming patch always renders
        // `committedPreamble + acc` so the user sees a continuous reply
        // building up across tool rounds.
        let committedPreamble = "";
        // Vega-Lite blocks salvaged from tool results — appended to the
        // assistant message at the end so charts render whether or not the
        // model echoes the spec.
        const harvestedCharts: string[] = [];

        const patchCallRecords = () => {
          // Shallow copy preserves per-record identity for unchanged calls
          // (records are replaced in place at the index that mutated), so
          // memoized ToolRow children skip re-rendering when only one of
          // many calls transitions running → complete.
          const snapshot = [...callRecords];
          patch((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, toolCalls: snapshot } : m,
            ),
          );
        };

        // Reasoning models reject `max_tokens` and require
        // `max_completion_tokens`; they also need a much larger budget
        // because reasoning tokens are billed against the same cap.
        // Either is overridable via the provider's extra_params, which
        // merge in last and win. Hoisted out of the loop — the values
        // don't change between iterations and the post-loop synthesis
        // call below also reads them.
        const reasoning = isReasoningModel(chosenModel);
        const tokenLimitField = reasoning
          ? "max_completion_tokens"
          : "max_tokens";
        const tokenLimit = reasoning
          ? DEFAULT_REASONING_MAX_TOKENS
          : DEFAULT_MAX_TOKENS;

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
          onTextProgress?: (snapshot: {
            readonly content: string;
            readonly reasoning: string;
          }) => void,
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
              onTextProgress,
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

        // Signatures of the previous round's tool calls. We append a
        // hint to any result whose `(name, args)` matches a call from
        // the immediately-preceding round, nudging the model to vary
        // its arguments instead of looping on the same lookup.
        let lastCallSignatures = new Set<string>();

        // Tracks every role:"tool" message we've appended, with the
        // iteration that produced it and a one-line summary. On long
        // loops we walk this list at iteration start and replace
        // older messages' content with the summary so the request body
        // doesn't grow unboundedly. Aging is reversible only by the
        // model re-issuing the same call.
        interface ToolMessageMeta {
          readonly apiIndex: number;
          readonly iteration: number;
          readonly summary: string;
          readonly fullBytes: number;
          aged: boolean;
        }
        const toolMessageMetas: ToolMessageMeta[] = [];

        // Build a one-line summary of a tool result for the aging path.
        // Keeps the head and tail short enough that the model can still
        // recognise what the call returned without re-running it.
        const buildToolSummary = (
          toolName: string,
          rawArgs: string,
          fullContent: string,
          isError: boolean,
        ): string => {
          const argDigest =
            rawArgs && rawArgs.length > 80
              ? `${rawArgs.slice(0, 77)}…`
              : rawArgs || "{}";
          const firstLine =
            fullContent.split("\n", 1)[0]?.slice(0, 120) ?? "";
          const status = isError ? " [error]" : "";
          return (
            `[aged] ${toolName}(${argDigest}) → ${fullContent.length} bytes${status}` +
            (firstLine ? `; first line: ${firstLine}` : "") +
            "\n[note] Full result elided to keep context lean. Re-issue the same call if you need the data again."
          );
        };

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          if (ac.signal.aborted) break;

          // Age old tool results before sending the next request. We
          // mutate apiMessages[idx].content in place; meta.aged guards
          // against repeating the work each iteration.
          if (iter > 0 && toolMessageMetas.length > 0) {
            for (const meta of toolMessageMetas) {
              if (meta.aged) continue;
              if (iter - meta.iteration <= TOOL_AGING_AFTER_ROUNDS) continue;
              if (meta.fullBytes < TOOL_AGING_MIN_BYTES) {
                meta.aged = true;
                continue;
              }
              const target = apiMessages[meta.apiIndex];
              if (target && target.role === "tool") {
                apiMessages[meta.apiIndex] = {
                  role: "tool",
                  tool_call_id: target.tool_call_id,
                  content: meta.summary,
                };
              }
              meta.aged = true;
            }
          }

          // Re-arm the "Thinking…" indicator for iterations after the
          // first. The initial stub already has awaitingResponse=true; on
          // the second+ iteration the previous round's `markFirstDelta`
          // cleared it, so without this patch the indicator would stay
          // hidden across the silent inter-iteration gap.
          if (iter > 0) {
            patch((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, awaitingResponse: true } : m,
              ),
            );
          }

          // Last allowed iteration when we've already gathered evidence:
          // pin tool_choice to "none" so the model is forced to synthesise
          // a final answer in this round. Saves the separate post-loop
          // round-trip we used to make for the same purpose — and that
          // one was the slowest, since the context was at its largest by
          // the time it fired.
          const forceSynthesis =
            iter === MAX_TOOL_ITERATIONS - 1 &&
            tools.length > 0 &&
            callRecords.length > 0;
          if (forceSynthesis) {
            apiMessages.push({
              role: "system",
              content:
                "Tool-call budget reached. Synthesise a final answer from the evidence above. Do not request more tools.",
            });
          }

          const stream = client.chatStream(
            {
              model: chosenModel,
              messages: apiMessages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice:
                tools.length > 0
                  ? forceSynthesis
                    ? "none"
                    : "auto"
                  : undefined,
              // Encourage providers (notably OpenAI) to emit multiple
              // tool_calls in a single turn so we can dispatch them in
              // parallel below. User-supplied extra_params spread last
              // can override (e.g. a buggy proxy that mishandles it).
              // Skip on the synthesis iteration — no tools will fire.
              ...(tools.length > 0 && !forceSynthesis
                ? { parallel_tool_calls: true }
                : {}),
              [tokenLimitField]: tokenLimit,
              ...extraBody,
            },
            { signal: ac.signal },
          );

          let acc = "";
          const toolCalls: AccumulatedToolCall[] = [];
          let finishReason: string | null = null;
          // Cleared on the first delta of any kind — drives the
          // "Thinking…" indicator while the HTTP request is in flight.
          let firstDeltaSeen = false;
          const markFirstDelta = () => {
            if (firstDeltaSeen) return;
            firstDeltaSeen = true;
            patch((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, awaitingResponse: false } : m,
              ),
            );
          };

          for await (const chunk of stream) {
            const choice = chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta;

            if (delta?.tool_calls) {
              markFirstDelta();
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
              markFirstDelta();
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
              markFirstDelta();
              acc += delta.content;
              // Stream every chunk live, including text that turns out to
              // precede a tool_call ("Let me check the file…"). When the
              // iteration ends in tool_calls we commit `acc` into
              // `committedPreamble` below, so the next iteration's empty
              // buffer doesn't wipe the user's view of the preamble.
              const snapshot = committedPreamble + acc;
              patch((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: snapshot } : m,
                ),
              );
            }

            if (choice.finish_reason) finishReason = choice.finish_reason;
          }

          // Post-stream: branch on whether the model wants more tool calls.
          // On the synthesis iteration we never dispatch — even if the
          // model defied tool_choice:"none" and emitted tool_calls, the
          // budget is already spent.
          if (
            !forceSynthesis &&
            finishReason === "tool_calls" &&
            toolCalls.length > 0
          ) {
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
                round: iter + 1,
              });
            }
            patchCallRecords();

            // Dispatch all tool calls concurrently. Independent reads /
            // searches / fetches stop being serialised, which both speeds
            // up multi-step exploration and stops penalising the model
            // for fanning out. `Promise.all` preserves input order so
            // the corresponding `role: "tool"` messages we append below
            // line up with the assistant's tool_call ids.
            const thisRoundSignatures = new Set<string>();
            for (const { tc } of dispatched) {
              thisRoundSignatures.add(`${tc.name}\0${tc.arguments || ""}`);
            }
            const settled = await Promise.all(
              dispatched.map(async ({ tc, callId }) => {
                const binding = resolveTool(tc.name);
                const isDispatchAgent =
                  binding?.serverId === BUILTIN_SERVER_ID &&
                  binding.toolName === DISPATCH_AGENT_TOOL_NAME;
                const startedAt = performance.now();
                // Subscribe to live progress heartbeats for this specific
                // call. Tools that don't emit (everything except web_fetch
                // / read_pdf / read_excel / analyse_data) just leave the
                // callback dormant — no heartbeat ever fires, no patches.
                const unregisterProgress = isDispatchAgent
                  ? undefined
                  : registerToolProgress(callId, (label) => {
                      const idx = recordIndex.get(callId);
                      if (idx === undefined || !callRecords[idx]) return;
                      callRecords[idx] = {
                        ...callRecords[idx]!,
                        progress: label,
                      };
                      patchCallRecords();
                    });
                const { result: rawResult, isError } = isDispatchAgent
                  ? await runDispatchAgent(
                      tc.arguments,
                      (nested) => {
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
                      },
                      ({ content, reasoning }) => {
                        // Surface the sub-agent's running text into the
                        // dispatch row's `result` so the user sees what
                        // the sub-agent is doing instead of a silent
                        // spinner. Replaced verbatim once the sub-agent
                        // settles below.
                        const idx = recordIndex.get(callId);
                        if (idx === undefined || !callRecords[idx]) return;
                        const preview = content.trim()
                          ? content
                          : reasoning.trim()
                            ? `[thinking]\n${reasoning}`
                            : "";
                        if (!preview) return;
                        callRecords[idx] = {
                          ...callRecords[idx]!,
                          result: preview,
                        };
                        patchCallRecords();
                      },
                    )
                  : await runToolCall(binding, tc.name, tc.arguments, callId);
                unregisterProgress?.();
                // Build the version the model will see: cap oversize,
                // append a recovery hint on errors, flag exact repeats.
                let modelResult = rawResult;
                if (isError) {
                  const hint = recoveryHintFor(tc.name, rawResult);
                  if (hint) modelResult = `${rawResult}\n\n[hint] ${hint}`;
                }
                const sig = `${tc.name}\0${tc.arguments || ""}`;
                if (lastCallSignatures.has(sig)) {
                  modelResult = `${modelResult}\n\n[note] This is an identical call to one you just made. If you need different data, change the arguments; otherwise stop calling this tool and use what you have.`;
                }
                modelResult = capToolResultForModel(modelResult);
                const durationMs = Math.round(performance.now() - startedAt);
                // Patch the UI as each call settles so the user sees
                // running → complete transitions live, not all at once.
                const idx = recordIndex.get(callId);
                const existing =
                  idx !== undefined ? callRecords[idx] : undefined;
                if (idx !== undefined && existing) {
                  callRecords[idx] = {
                    ...existing,
                    // UI gets the raw, untruncated result so the user
                    // can inspect what really came back. The model gets
                    // the capped/hinted version we built above.
                    result: rawResult,
                    status: isError ? "error" : "complete",
                    isError,
                    durationMs,
                    // Settled rows show the result; the heartbeat label
                    // is no longer meaningful and would otherwise stick.
                    progress: undefined,
                  };
                  patchCallRecords();
                }
                return {
                  callId,
                  rawResult,
                  modelResult,
                  isError,
                  toolName: tc.name,
                  toolArgs: tc.arguments || "{}",
                };
              }),
            );

            for (const { rawResult, isError } of settled) {
              if (!isError) {
                for (const block of extractVegaBlocks(rawResult)) {
                  harvestedCharts.push(block);
                }
              }
            }
            for (const {
              callId,
              modelResult,
              toolName,
              toolArgs,
              isError,
            } of settled) {
              const apiIndex = apiMessages.length;
              apiMessages.push({
                role: "tool",
                tool_call_id: callId,
                content: modelResult,
              });
              // Record the meta so a later iteration can swap this
              // entry's content for the one-line summary if it ages.
              toolMessageMetas.push({
                apiIndex,
                iteration: iter,
                fullBytes: modelResult.length,
                summary: buildToolSummary(
                  toolName,
                  toolArgs,
                  modelResult,
                  isError,
                ),
                aged: false,
              });
            }
            // Commit any text the model emitted before its tool calls so
            // the live transcript keeps showing it on subsequent
            // iterations and it survives into the final message.
            if (acc.trim().length > 0) {
              committedPreamble += acc.endsWith("\n") ? acc : `${acc}\n\n`;
            }
            lastCallSignatures = thisRoundSignatures;
            // Loop back for the next iteration.
            continue;
          }

          // Terminal: this iteration's text is the final response. Prepend
          // any preamble accumulated from earlier tool-call iterations so
          // the user reads the model's full reasoning, not just the
          // closing summary.
          finalContent = committedPreamble + acc;
          break;
        }

        // Safety net: the in-loop `forceSynthesis` should always populate
        // finalContent on the last iteration, but if a misbehaving model
        // defied tool_choice:"none" and emitted nothing, fall back to the
        // preamble we already showed the user — or, failing that, a
        // plain "stopped" placeholder so the bubble isn't blank.
        if (!ac.signal.aborted && !finalContent.trim()) {
          if (committedPreamble.trim()) {
            finalContent = committedPreamble.trimEnd();
          } else if (callRecords.length > 0) {
            finalContent =
              "_(stopped — tool-call budget exhausted with no synthesis from the model)_";
          }
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
                  awaitingResponse: false,
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
                    awaitingResponse: false,
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
                    awaitingResponse: false,
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
        // Drain any rAF-deferred patch before flipping isStreaming so the
        // user sees the final transcript synchronously, not "done" over a
        // one-frame-stale view.
        flushPending();
        if (abortRef.current === ac) abortRef.current = null;
        setIsStreaming(false);
      }
    },
    [provider, isStreaming, patch, flushPending],
  );

  return { isStreaming, error, send, stop };
}
