import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button, Kbd } from "../../components/ui";
import { useMcpServers } from "../../hooks/use-mcp-servers";
import { useModels } from "../../hooks/use-models";
import { useSkills } from "../../hooks/use-skills";
import type { ChatExtras, McpToolBinding } from "../../hooks/use-chat";
import type { ProviderConfig } from "../../features/providers";
import {
  BUILTIN_GROUP_LABEL,
  BUILTIN_SERVER_ID,
  BUILTIN_SLASH_COMMANDS,
  type BuiltinSlashCommand,
  type BuiltinToolDef,
  type BuiltinToolGroup,
  setBuiltinUiHandlers,
  useBuiltinTools,
} from "../../lib/builtin-tools";
import {
  contextWindowFor,
  estimateMessageTokens,
  estimateTokens,
} from "../../lib/llm/context-window";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
  McpServerRuntime,
  McpToolInfo,
  Skill,
  TranscriptMessage,
} from "../../app/types";

interface ComposerProps {
  /** Send a user message. The `extras` payload carries hidden context the
   * model should see this turn — selected MCP prompts/resources as system
   * messages, and the set of MCP tools the model may call. None of it
   * appears in the transcript. */
  readonly onSend: (text: string, extras: ChatExtras) => void;
  /** Stop the current streaming response. The composer shows a stop button
   * in place of send while `isStreaming` is true. */
  readonly onStop?: () => void;
  /** Disabled for non-streaming reasons (no provider, no model). */
  readonly disabled?: boolean;
  /** True while a response is streaming — flips Send into Stop. */
  readonly isStreaming?: boolean;
  readonly hint?: string;
  /** Provider in use — drives the model picker and `/models` discovery. */
  readonly provider?: ProviderConfig;
  /** Model id selected by the user, or undefined to use provider default. */
  readonly selectedModel?: string;
  readonly onSelectModel?: (model: string) => void;
  /** Visible transcript messages — feeds the context window indicator. */
  readonly messages?: readonly TranscriptMessage[];
  /** Timestamp of the most recent context reset. Messages older than this
   * are still rendered in the transcript but no longer count against the
   * model's context window. */
  readonly contextResetAt?: string;
  /** Reset the conversation's model-side context. Triggered by clicking the
   * context-usage chip. The visible transcript is left intact. */
  readonly onResetContext?: () => void;
  /** Hard reset: wipe the visible transcript AND drop model-side context.
   * Triggered by `/clear` or the built-in `clear` tool. */
  readonly onClearTranscript?: () => void;
  /** Active workspace's attached folder, when one is set. Forwarded into
   * the built-in tool dispatcher so relative paths in tool calls land
   * inside it, and surfaced as a system-context entry on each send so the
   * model knows where it is. */
  readonly workspacePath?: string;
}

/** A prompt or resource the user has loaded into context for the next
 * message. Stored entirely on the frontend — sent to the model as a system
 * message via `ChatExtras.systemContext`, never written to the transcript. */
interface PendingContextEntry {
  readonly id: string;
  readonly kind: "prompt" | "resource";
  readonly serverName: string;
  readonly label: string;
  readonly content: string;
}

type ChipKind = "tools" | "prompts" | "resources";

interface ServerGroup<T> {
  readonly server: McpServerConfig;
  readonly items: readonly T[];
  readonly listError: string | undefined;
}

export function Composer({
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  hint,
  provider,
  selectedModel,
  onSelectModel,
  messages,
  contextResetAt,
  onResetContext,
  onClearTranscript,
  workspacePath,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState<boolean>(false);
  const [builtinOpen, setBuiltinOpen] = useState<boolean>(false);
  const [modelMenuOpen, setModelMenuOpen] = useState<boolean>(false);
  // One-shot status line for built-in slash commands that write to disk
  // (`/write-to-workspace`). Self-clears after a few seconds so the
  // composer doesn't hold onto stale messages. Distinct from `hint` —
  // `hint` is provider/error driven and owned by the parent.
  const [notice, setNotice] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!notice) return;
    const handle = window.setTimeout(() => setNotice(undefined), 4000);
    return () => window.clearTimeout(handle);
  }, [notice]);
  const activeModel = selectedModel || provider?.model;
  const modelsApi = useModels(provider);
  // Per-item invocation state — `${serverId}::${name|uri}` → "running" or
  // an error message. We display loading + failure inline next to the row
  // that triggered it instead of a global toast.
  const [itemState, setItemState] = useState<
    Readonly<Record<string, "running" | { error: string }>>
  >({});
  // MCP prompts / resources the user has loaded for the next send. Kept
  // entirely off the transcript — they ride along on `extras.systemContext`.
  const [pendingContext, setPendingContext] = useState<
    readonly PendingContextEntry[]
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mcpTriggerRef = useRef<HTMLButtonElement>(null);
  const mcpPopoverRef = useRef<HTMLDivElement>(null);
  const builtinTriggerRef = useRef<HTMLButtonElement>(null);
  const builtinPopoverRef = useRef<HTMLDivElement>(null);
  const canSend =
    text.trim().length > 0 && !disabled && !isStreaming && !!activeModel;

  const { servers, runtime, setToolEnabled, setPromptEnabled } =
    useMcpServers();
  const { skills, render: renderSkill } = useSkills();
  const builtinTools = useBuiltinTools();

  // Slash-command parser. The user types `/skill-name args…` or
  // `/builtin-command`; we open a filterable popover as soon as the
  // textarea opens with `/` so they can pick an entry without typing
  // the full name. `null` means no menu.
  const slash = useMemo<SlashState | null>(
    () => parseSlash(text, skills, BUILTIN_SLASH_COMMANDS),
    [text, skills],
  );
  // Highlight index for keyboard navigation within the slash popover.
  const [slashHighlight, setSlashHighlight] = useState(0);
  const slashCandidates = slash?.candidates ?? EMPTY_SLASH_ITEMS;
  // Snap the highlight back to the first row whenever the candidate set
  // changes — easier than threading the index through `parseSlash`.
  useEffect(() => {
    setSlashHighlight(0);
  }, [slash?.query, slashCandidates.length]);

  // Close the MCP popover on any mousedown outside the trigger or the
  // popover itself. mousedown (not click) so the popover dismisses before
  // focus shifts into the textarea or another control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mcpTriggerRef.current?.contains(target)) return;
      if (mcpPopoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Same dismiss behaviour for the built-in tools popover. Two refs / two
  // effects rather than a unified controller — keeps each popover's
  // open/close lifecycle independent so opening one auto-closes the other
  // implicitly via the outside-click on its trigger.
  useEffect(() => {
    if (!builtinOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (builtinTriggerRef.current?.contains(target)) return;
      if (builtinPopoverRef.current?.contains(target)) return;
      setBuiltinOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [builtinOpen]);

  // Register the React-side clear handler and the active workspace folder
  // so the built-in tool dispatcher can reach them. Module-level registry
  // avoids threading these through the agent loop, which has no business
  // knowing about UI affordances or the workspace concept.
  useEffect(() => {
    setBuiltinUiHandlers({
      clearTranscript: onClearTranscript,
      workspacePath,
    });
    return () =>
      setBuiltinUiHandlers({
        clearTranscript: undefined,
        workspacePath: undefined,
      });
  }, [onClearTranscript, workspacePath]);

  /** Discoverable skills shown to the model on every send. Mirrors Claude
   * Desktop's "metadata always pre-loaded" behaviour: name + description
   * for every skill that hasn't opted out of model invocation. The full
   * body is only injected when the user explicitly invokes one with `/`. */
  const discoverableSkills = useMemo(
    () =>
      skills.filter(
        (s) => !s.disableModelInvocation && !s.error,
      ),
    [skills],
  );

  // Walk every server with a "connected" runtime entry and aggregate its
  // discovered items per-kind. Each group keeps its source server so the
  // popover can render section headers.
  const groups = useMemo(() => {
    const tools: ServerGroup<McpToolInfo>[] = [];
    const prompts: ServerGroup<McpPromptInfo>[] = [];
    const resources: ServerGroup<McpResourceInfo>[] = [];
    for (const server of servers) {
      const r: McpServerRuntime | undefined = runtime[server.id];
      if (!r || r.status !== "connected") continue;
      tools.push({ server, items: r.tools, listError: r.toolsError });
      prompts.push({ server, items: r.prompts, listError: r.promptsError });
      resources.push({
        server,
        items: r.resources,
        listError: r.resourcesError,
      });
    }
    return { tools, prompts, resources };
  }, [servers, runtime]);

  const counts: Record<ChipKind, number> = useMemo(
    () => ({
      tools: groups.tools.reduce(
        (acc, g) => acc + activeToolCount(g),
        0,
      ),
      prompts: groups.prompts.reduce(
        (acc, g) => acc + activePromptCount(g),
        0,
      ),
      resources: groups.resources.reduce(
        (acc, g) => acc + g.items.length,
        0,
      ),
    }),
    [groups],
  );

  /** Total advertised across all connected servers, ignoring user toggles.
   * Used for the `enabled/total` ratio in the chip count — tools and prompts
   * are opt-out / opt-in respectively, and the ratio gives a quick read of
   * "how many of what's available am I currently using". */
  const totals: Record<ChipKind, number> = useMemo(
    () => ({
      tools: groups.tools.reduce((acc, g) => acc + g.items.length, 0),
      prompts: groups.prompts.reduce((acc, g) => acc + g.items.length, 0),
      resources: groups.resources.reduce(
        (acc, g) => acc + g.items.length,
        0,
      ),
    }),
    [groups],
  );

  const anyConnected = groups.tools.length > 0;

  const togglePopover = () => {
    if (!anyConnected) return;
    setOpen((curr) => !curr);
  };

  const setRunning = (key: string) =>
    setItemState((s) => ({ ...s, [key]: "running" }));
  const setItemError = (key: string, error: string) =>
    setItemState((s) => ({ ...s, [key]: { error } }));
  const clearItem = (key: string) =>
    setItemState(({ [key]: _drop, ...rest }) => rest);

  /** Add a prompt / resource to the hidden context cart for the next send.
   * No-op when the same item is already pending (idempotent click). */
  const addPendingContext = useCallback((entry: PendingContextEntry) => {
    setPendingContext((prev) => {
      if (prev.some((p) => p.id === entry.id)) return prev;
      return [...prev, entry];
    });
  }, []);

  const removePendingContext = useCallback((id: string) => {
    setPendingContext((prev) => prev.filter((p) => p.id !== id));
  }, []);

  /** Fetch every prompt the user has marked enabled (across all connected
   * servers) and concatenate the results into a list of system messages.
   * Called from `submit` so each send sees fresh content — if a prompt
   * changes server-side, the next message picks it up automatically. */
  const fetchEnabledPromptContext = async (): Promise<string[]> => {
    const targets: { server: McpServerConfig; prompt: McpPromptInfo }[] = [];
    for (const group of groups.prompts) {
      const enabled = new Set(group.server.enabledPrompts ?? []);
      if (enabled.size === 0) continue;
      for (const prompt of group.items) {
        if (enabled.has(prompt.name)) {
          targets.push({ server: group.server, prompt });
        }
      }
    }
    if (targets.length === 0) return [];

    const results = await Promise.all(
      targets.map(async ({ server, prompt }) => {
        try {
          const result = await window.helixApi.callMcpPrompt(
            server.id,
            prompt.name,
            {},
          );
          if (result.error) {
            return (
              contextHeader("prompt", server.name, prompt.name) +
              `Failed to load this prompt: ${result.error}`
            );
          }
          const content = result.messages
            .map((m) => m.content)
            .join("\n\n");
          return (
            contextHeader("prompt", server.name, prompt.name) + content
          );
        } catch (err) {
          return (
            contextHeader("prompt", server.name, prompt.name) +
            `Failed to load this prompt: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }),
    );
    return results;
  };

  const onReadResource = async (
    server: McpServerConfig,
    resource: McpResourceInfo,
  ) => {
    const entryId = `resource:${server.id}:${resource.uri}`;
    const key = `${server.id}::resource::${resource.uri}`;
    if (pendingContext.some((p) => p.id === entryId)) {
      setOpen(false);
      return;
    }
    setRunning(key);
    try {
      const result = await window.helixApi.readMcpResource(
        server.id,
        resource.uri,
      );
      if (result.error) {
        setItemError(key, result.error);
        return;
      }
      addPendingContext({
        id: entryId,
        kind: "resource",
        serverName: server.name,
        label: resource.uri,
        content:
          contextHeader("resource", server.name, resource.uri) +
          result.content,
      });
      clearItem(key);
      setOpen(false);
    } catch (err) {
      setItemError(key, err instanceof Error ? err.message : String(err));
    }
  };

  /** Build the McpToolBinding list passed to the chat hook. We include every
   * advertised tool from a *connected* server that hasn't been disabled by
   * the user — so the toggle in the menu controls model visibility directly.
   * Built-in tools (Read / Write / Edit / Glob / Grep) ride the same list
   * with a sentinel server id; `useChat`'s dispatcher routes them to the
   * Tauri backend instead of an MCP transport. */
  const mcpToolBindings = useMemo<readonly McpToolBinding[]>(() => {
    const out: McpToolBinding[] = [];
    for (const tool of builtinTools.tools) {
      if (!builtinTools.isEnabled(tool.name)) continue;
      out.push({
        serverId: BUILTIN_SERVER_ID,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    for (const group of groups.tools) {
      const disabled = new Set(group.server.disabledTools ?? []);
      for (const tool of group.items) {
        if (disabled.has(tool.name)) continue;
        out.push({
          serverId: group.server.id,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }, [groups.tools, builtinTools]);

  async function submit() {
    // `/clear` short-circuits the whole pipeline: drop the input, wipe
    // the visible transcript, and don't ship anything to the provider.
    // Checked before `canSend` so the user can clear even when no
    // provider / model is configured. Trailing whitespace is tolerated
    // so ⌫-then-↵ on a stray space still works.
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "/clear") {
      setText("");
      setPendingContext([]);
      onClearTranscript?.();
      return;
    }
    // `/write-to-workspace` saves the most recent assistant response as a
    // markdown file in the workspace folder. Like `/clear`, it never
    // round-trips to the model — purely a client-side affordance. Tables,
    // code fences, and chart specs in the response are already markdown,
    // so the file content is `<short header>\n\n<message body>`.
    if (trimmed === "/write-to-workspace") {
      setText("");
      await writeLatestAssistantToWorkspace(
        messages,
        workspacePath,
        setNotice,
      );
      return;
    }
    if (!canSend) return;
    // Snapshot text + clear immediately so the textarea feels responsive
    // while we round-trip to MCP for prompt content.
    const userText = text;
    setText("");
    const oneShotContext = pendingContext.map((p) => p.content);
    setPendingContext([]);

    const promptContext = await fetchEnabledPromptContext();
    const skillContext = await buildSkillContext(
      userText,
      skills,
      renderSkill,
      discoverableSkills,
    );
    const workspaceContext = buildWorkspaceContext(workspacePath);

    const extras: ChatExtras = {
      // Workspace pin goes first so the model has the working directory
      // grounded before any user-facing prompt or skill body renders.
      // Persistent prompt context follows so it can lean on that pin;
      // one-shot resources come next; the skill body sits closest to the
      // user's text — same ordering Claude Code uses.
      systemContext: [
        ...workspaceContext,
        ...promptContext,
        ...oneShotContext,
        ...skillContext,
      ],
      mcpTools: mcpToolBindings,
      model: selectedModel,
    };
    onSend(userText, extras);
  }

  /** Apply an entry the user picked from the slash popover. Skills get
   * a trailing space so the user can immediately type arguments — same
   * UX shape as Claude Code. Built-in commands take no args, so we omit
   * the space and the user just hits Enter to fire them. */
  const onPickSlashItem = useCallback(
    (item: SlashItem) => {
      const next =
        item.kind === "skill"
          ? `/${item.skill.name} `
          : `/${item.command.name}`;
      setText(next);
      setSlashHighlight(0);
      // Defer focus so the textarea picks up the new value first.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(next.length, next.length);
      });
    },
    [],
  );

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Slash menu navigation takes priority when it's open.
    if (slash && slashCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashHighlight((i) => (i + 1) % slashCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashHighlight((i) =>
          i === 0 ? slashCandidates.length - 1 : i - 1,
        );
        return;
      }
      // Tab and Enter both insert the highlighted candidate (skills get a
      // trailing space, builtins don't — see `onPickSlashItem`) and leave
      // the user in the composer. A second Enter — once the menu has
      // closed — sends the message.
      const isAccept =
        e.key === "Tab" ||
        (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing);
      if (isAccept) {
        e.preventDefault();
        const pick = slashCandidates[slashHighlight];
        if (pick) onPickSlashItem(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Drop the leading slash to dismiss the menu without losing what
        // the user has typed afterwards.
        setText((t) => (t.startsWith("/") ? t.slice(1) : t));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {notice || hint ? (
          <div className="composer-status">{notice ?? hint}</div>
        ) : null}
        <div className="composer-tools">
          <ToolChip
            buttonRef={builtinTriggerRef}
            icon={<HammerIcon />}
            label="Helix Core"
            count={`${builtinTools.enabledNames.length}/${builtinTools.tools.length}`}
            active={builtinOpen}
            tooltip="Helix Core tools (Read, Write, Edit, Glob, Grep) — enabled by default"
            onClick={() => setBuiltinOpen((v) => !v)}
          />
          <ToolChip
            buttonRef={mcpTriggerRef}
            icon={<WrenchIcon />}
            label="MCP"
            count={`${counts.tools + counts.prompts}/${totals.tools + totals.prompts + totals.resources}`}
            active={open}
            disabled={!anyConnected}
            onClick={togglePopover}
          />
          <ContextUsageChip
            messages={messages ?? EMPTY_TRANSCRIPT}
            pendingContext={pendingContext}
            modelId={activeModel}
            contextResetAt={contextResetAt}
            onReset={onResetContext}
          />
          <span className="composer-tools-spacer" />
          {provider ? (
            <ModelChip
              activeModel={activeModel}
              models={modelsApi.models}
              isLoading={modelsApi.isLoading}
              error={modelsApi.error}
              fromEndpoint={modelsApi.fromEndpoint}
              open={modelMenuOpen}
              onToggle={() => setModelMenuOpen((v) => !v)}
              onClose={() => setModelMenuOpen(false)}
              onPick={(m) => {
                onSelectModel?.(m);
                setModelMenuOpen(false);
              }}
              onRefresh={modelsApi.refresh}
            />
          ) : null}
        </div>

        {pendingContext.length > 0 ? (
          <div className="composer-context" role="list">
            {pendingContext.map((entry) => (
              <span
                key={entry.id}
                role="listitem"
                className="composer-context-chip"
                data-kind={entry.kind}
                title={`${entry.kind === "prompt" ? "Prompt" : "Resource"} from ${entry.serverName} — sent as hidden system context on the next message.`}
              >
                <span className="composer-context-kind">
                  {entry.kind === "prompt" ? "prompt" : "resource"}
                </span>
                <span className="composer-context-label">{entry.label}</span>
                <button
                  type="button"
                  className="composer-context-remove"
                  onClick={() => removePendingContext(entry.id)}
                  aria-label={`Remove ${entry.label}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {open && anyConnected ? (
          <McpDiscoveryPopover
            popoverRef={mcpPopoverRef}
            tools={groups.tools}
            prompts={groups.prompts}
            resources={groups.resources}
            itemState={itemState}
            onClose={() => setOpen(false)}
            onToggleTool={(serverId, toolName, nextEnabled) =>
              void setToolEnabled(serverId, toolName, nextEnabled)
            }
            onTogglePrompt={(serverId, promptName, nextEnabled) =>
              void setPromptEnabled(serverId, promptName, nextEnabled)
            }
            onReadResource={(server, resource) =>
              void onReadResource(server, resource)
            }
          />
        ) : null}

        {builtinOpen ? (
          <BuiltinDiscoveryPopover
            popoverRef={builtinPopoverRef}
            tools={builtinTools.tools}
            isEnabled={builtinTools.isEnabled}
            enabledCount={builtinTools.enabledNames.length}
            onToggle={builtinTools.setEnabled}
            onClose={() => setBuiltinOpen(false)}
          />
        ) : null}

        <div className="composer-card">
          {slash ? (
            <SkillsSlashMenu
              candidates={slashCandidates}
              highlight={slashHighlight}
              query={slash.query}
              onHover={setSlashHighlight}
              onPick={onPickSlashItem}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              isStreaming
                ? "Streaming…"
                : "Message the assistant. Type / for skills and commands."
            }
            rows={1}
            disabled={disabled && !isStreaming}
          />
          <div className="composer-toolbar">
            <div className="composer-hint">
              <span>
                <Kbd>↵</Kbd> send
              </span>
              <span>
                <Kbd>⇧</Kbd>+<Kbd>↵</Kbd> newline
              </span>
              <span>
                <Kbd>/</Kbd> skills
              </span>
            </div>
            {isStreaming && onStop ? (
              <Button variant="destructive" onClick={() => onStop()}>
                Stop
                <StopIcon />
              </Button>
            ) : (
              <Button disabled={!canSend} onClick={() => void submit()}>
                Send
                <SendIcon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Write the most recent assistant message to the workspace as a markdown
 * file. Surfaces success / failure / no-op states through the supplied
 * `setNotice` callback so the composer can show a transient inline status.
 * The file body is the assistant's content verbatim — already markdown, so
 * tables / code fences / vega-lite blocks survive the round-trip — preceded
 * by a single-line header (title + timestamp). */
async function writeLatestAssistantToWorkspace(
  messages: readonly TranscriptMessage[] | undefined,
  workspacePath: string | undefined,
  setNotice: (text: string | undefined) => void,
): Promise<void> {
  if (!workspacePath) {
    setNotice("/write-to-workspace: attach a workspace folder first.");
    return;
  }
  const list = messages ?? [];
  let last: TranscriptMessage | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === "assistant" && m.content.trim().length > 0) {
      last = m;
      break;
    }
  }
  if (!last) {
    setNotice("/write-to-workspace: no assistant response to save yet.");
    return;
  }

  const ts = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const fileName = `chat-export-${stamp}.md`;
  const sep = /[\\/]$/.test(workspacePath) ? "" : "/";
  const path = `${workspacePath}${sep}${fileName}`;
  const header = `# Chat export — ${ts.toLocaleString()}\n\n`;
  const content = `${header}${last.content}\n`;

  try {
    const result = await window.helixApi.writeFile(path, content);
    setNotice(`Saved to ${result.path}`);
  } catch (err) {
    setNotice(
      `/write-to-workspace failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** When the active workspace has an attached folder, tell the model about
 * it so file-writing tools land in the right place. Returns an empty list
 * (caller spreads it) when no folder is attached, leaving extras unchanged. */
function buildWorkspaceContext(path: string | undefined): string[] {
  if (!path) return [];
  return [
    [
      "[helix workspace]",
      `The user's active workspace folder is: ${path}`,
      "When you call file-system tools (read_file, write_file, edit_file,",
      "glob_files, grep_search, search_files, read_pdf, read_excel), use",
      "this folder as the working directory. Relative paths in tool",
      "arguments are resolved against it; search tools that take a root",
      "default to it. Prefer relative paths so files land inside the user's",
      "workspace unless the user explicitly asks for a different location.",
    ].join("\n"),
  ];
}

/** Wrap the content sent to the model with a tiny attribution header, so a
 * model that's seeing many MCP-derived system messages can tell where each
 * came from. Visible only inside the API call, never the transcript. */
function contextHeader(
  kind: "prompt" | "resource",
  serverName: string,
  label: string,
): string {
  return `[helix mcp ${kind} · ${serverName} · ${label}]\n`;
}

function activeToolCount(group: ServerGroup<McpToolInfo>): number {
  const disabled = new Set(group.server.disabledTools ?? []);
  let n = 0;
  for (const t of group.items) {
    if (!disabled.has(t.name)) n++;
  }
  return n;
}

function activePromptCount(group: ServerGroup<McpPromptInfo>): number {
  const enabled = new Set(group.server.enabledPrompts ?? []);
  if (enabled.size === 0) return 0;
  let n = 0;
  for (const p of group.items) {
    if (enabled.has(p.name)) n++;
  }
  return n;
}

function isToolEnabled(server: McpServerConfig, toolName: string): boolean {
  return !(server.disabledTools ?? []).includes(toolName);
}

function isPromptEnabled(
  server: McpServerConfig,
  promptName: string,
): boolean {
  return (server.enabledPrompts ?? []).includes(promptName);
}

interface ToolChipProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  /** Either a plain count (`5`) or a ratio string (`5/8`). gcf-desktop uses
   * the ratio for tools/prompts so a quick glance shows how much of what's
   * available is currently in play. */
  readonly count: number | string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly buttonRef?: React.Ref<HTMLButtonElement>;
  /** Override the default `title` string. The MCP chip falls back to a
   * connection-aware default; built-in / future chips can supply their own. */
  readonly tooltip?: string;
}

function ToolChip({
  icon,
  label,
  count,
  active,
  disabled,
  onClick,
  buttonRef,
  tooltip,
}: ToolChipProps) {
  const title =
    tooltip ??
    (disabled
      ? `${label} — connect an MCP server in Settings → MCP`
      : `${label} from connected MCP servers`);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="tool-chip"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="tool-chip-icon" aria-hidden>
        {icon}
      </span>
      {label}
      <span className="tool-chip-count">{count}</span>
      <ChevronDownIcon />
    </button>
  );
}

interface McpDiscoveryPopoverProps {
  readonly tools: readonly ServerGroup<McpToolInfo>[];
  readonly prompts: readonly ServerGroup<McpPromptInfo>[];
  readonly resources: readonly ServerGroup<McpResourceInfo>[];
  readonly itemState: Readonly<
    Record<string, "running" | { error: string }>
  >;
  readonly onClose: () => void;
  readonly onToggleTool: (
    serverId: string,
    toolName: string,
    nextEnabled: boolean,
  ) => void;
  readonly onTogglePrompt: (
    serverId: string,
    promptName: string,
    nextEnabled: boolean,
  ) => void;
  readonly onReadResource: (
    server: McpServerConfig,
    resource: McpResourceInfo,
  ) => void;
  readonly popoverRef?: React.Ref<HTMLDivElement>;
}

function McpDiscoveryPopover({
  tools,
  prompts,
  resources,
  itemState,
  onClose,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
  popoverRef,
}: McpDiscoveryPopoverProps) {
  const totalAdvertised =
    tools.reduce((a, g) => a + g.items.length, 0) +
    prompts.reduce((a, g) => a + g.items.length, 0) +
    resources.reduce((a, g) => a + g.items.length, 0);
  const errors = [
    ...tools
      .filter((g) => g.listError)
      .map((g) => ({ server: g.server, kind: "tools", error: g.listError! })),
    ...prompts
      .filter((g) => g.listError)
      .map((g) => ({
        server: g.server,
        kind: "prompts",
        error: g.listError!,
      })),
    ...resources
      .filter((g) => g.listError)
      .map((g) => ({
        server: g.server,
        kind: "resources",
        error: g.listError!,
      })),
  ];

  return (
    <div
      ref={popoverRef}
      className="mcp-menu"
      role="dialog"
      aria-label="Connected MCP servers"
    >
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            MCP
            <span className="mcp-menu-count">{totalAdvertised}</span>
          </div>
          <div className="mcp-menu-hint">
            Toggle a tag to enable every tool and prompt under it. Click a
            resource chip to attach its contents.
          </div>
        </div>
        <button
          type="button"
          className="mcp-menu-close"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </header>

      {totalAdvertised === 0 && errors.length === 0 ? (
        <p className="mcp-menu-empty">
          Connected, but no tools, prompts, or resources were advertised.
        </p>
      ) : (
        <UnifiedByServerThenTag
          tools={tools}
          prompts={prompts}
          resources={resources}
          errors={errors}
          itemState={itemState}
          onToggleTool={onToggleTool}
          onTogglePrompt={onTogglePrompt}
          onReadResource={onReadResource}
        />
      )}
    </div>
  );
}

const UNTAGGED = "Untagged";

interface UnifiedItem {
  readonly server: McpServerConfig;
  readonly kind: "tool" | "prompt" | "resource";
  /** Stable key per item: tool/prompt name, or resource uri. */
  readonly id: string;
  /** Display text on the chip. */
  readonly label: string;
  readonly description: string | undefined;
  readonly tags: readonly string[];
  /** Resource-only — passed back to onReadResource on click. */
  readonly resource?: McpResourceInfo;
}

interface UnifiedTagBucket {
  readonly tag: string;
  readonly items: readonly UnifiedItem[];
}

function tagsOrUntagged(tags: readonly string[] | undefined): readonly string[] {
  return tags && tags.length > 0 ? tags : [UNTAGGED];
}

function UnifiedByServerThenTag({
  tools,
  prompts,
  resources,
  errors,
  itemState,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
}: {
  readonly tools: readonly ServerGroup<McpToolInfo>[];
  readonly prompts: readonly ServerGroup<McpPromptInfo>[];
  readonly resources: readonly ServerGroup<McpResourceInfo>[];
  readonly errors: readonly {
    readonly server: McpServerConfig;
    readonly kind: string;
    readonly error: string;
  }[];
  readonly itemState: McpDiscoveryPopoverProps["itemState"];
  readonly onToggleTool: McpDiscoveryPopoverProps["onToggleTool"];
  readonly onTogglePrompt: McpDiscoveryPopoverProps["onTogglePrompt"];
  readonly onReadResource: McpDiscoveryPopoverProps["onReadResource"];
}) {
  /** Index every server by id, then collect each server's items into one
   * flat list keyed by `(kind, name|uri)`. We bucket per-tag *within* a
   * server below — the same tag from two servers stays in two distinct
   * subsections so toggling one server doesn't fan out to the other. */
  const perServer = useMemo(() => {
    const byId = new Map<string, McpServerConfig>();
    const items = new Map<string, UnifiedItem[]>();
    const collect = (server: McpServerConfig, item: UnifiedItem) => {
      byId.set(server.id, server);
      let list = items.get(server.id);
      if (!list) {
        list = [];
        items.set(server.id, list);
      }
      list.push(item);
    };
    for (const g of tools) {
      for (const t of g.items) {
        collect(g.server, {
          server: g.server,
          kind: "tool",
          id: t.name,
          label: t.name,
          description: t.description,
          tags: t.tags ?? [],
        });
      }
    }
    for (const g of prompts) {
      for (const p of g.items) {
        collect(g.server, {
          server: g.server,
          kind: "prompt",
          id: p.name,
          label: p.name,
          description: p.description,
          tags: p.tags ?? [],
        });
      }
    }
    for (const g of resources) {
      for (const r of g.items) {
        collect(g.server, {
          server: g.server,
          kind: "resource",
          id: r.uri,
          label: r.name || r.uri,
          description: r.mimeType,
          tags: r.tags ?? [],
          resource: r,
        });
      }
    }
    return Array.from(items.entries())
      .map(([serverId, list]) => ({
        server: byId.get(serverId)!,
        items: list,
      }))
      .sort((a, b) => a.server.name.localeCompare(b.server.name));
  }, [tools, prompts, resources]);

  return (
    <div className="mcp-menu-groups">
      {errors.map((e) => (
        <p
          key={`${e.server.id}::${e.kind}`}
          className="mcp-menu-section-error"
        >
          <strong>
            {e.server.name} · {e.kind}/list
          </strong>
          : {e.error}
        </p>
      ))}
      {perServer.map(({ server, items }) => (
        <ServerTagBlock
          key={server.id}
          server={server}
          items={items}
          itemState={itemState}
          onToggleTool={onToggleTool}
          onTogglePrompt={onTogglePrompt}
          onReadResource={onReadResource}
        />
      ))}
    </div>
  );
}

function ServerTagBlock({
  server,
  items,
  itemState,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
}: {
  readonly server: McpServerConfig;
  readonly items: readonly UnifiedItem[];
  readonly itemState: McpDiscoveryPopoverProps["itemState"];
  readonly onToggleTool: McpDiscoveryPopoverProps["onToggleTool"];
  readonly onTogglePrompt: McpDiscoveryPopoverProps["onTogglePrompt"];
  readonly onReadResource: McpDiscoveryPopoverProps["onReadResource"];
}) {
  const buckets: readonly UnifiedTagBucket[] = useMemo(() => {
    const map = new Map<string, UnifiedItem[]>();
    for (const item of items) {
      for (const tag of tagsOrUntagged(item.tags)) {
        let list = map.get(tag);
        if (!list) {
          list = [];
          map.set(tag, list);
        }
        list.push(item);
      }
    }
    return Array.from(map.entries())
      .map(([tag, list]) => ({ tag, items: list }))
      .sort((a, b) => {
        if (a.tag === UNTAGGED) return 1;
        if (b.tag === UNTAGGED) return -1;
        return a.tag.localeCompare(b.tag);
      });
  }, [items]);

  return (
    <section className="mcp-menu-section">
      <div className="mcp-menu-section-head">
        <span className="mcp-menu-section-name">{server.name}</span>
        <span className="mcp-menu-section-count">{items.length}</span>
      </div>
      <div className="mcp-menu-subgroups">
        {buckets.map(({ tag, items: bucket }) => (
          <TagSubsection
            key={tag}
            server={server}
            tag={tag}
            items={bucket}
            itemState={itemState}
            onToggleTool={onToggleTool}
            onTogglePrompt={onTogglePrompt}
            onReadResource={onReadResource}
          />
        ))}
      </div>
    </section>
  );
}

/** Returns the current "is this item considered active?" boolean. Resources
 * have no enable state — they're click-to-read — so they're always reported
 * active for counting purposes and excluded from the bulk toggle. */
function isItemActive(item: UnifiedItem): boolean {
  if (item.kind === "tool") return isToolEnabled(item.server, item.id);
  if (item.kind === "prompt") return isPromptEnabled(item.server, item.id);
  return true;
}

function TagSubsection({
  server,
  tag,
  items,
  itemState,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
}: {
  readonly server: McpServerConfig;
  readonly tag: string;
  readonly items: readonly UnifiedItem[];
  readonly itemState: McpDiscoveryPopoverProps["itemState"];
  readonly onToggleTool: McpDiscoveryPopoverProps["onToggleTool"];
  readonly onTogglePrompt: McpDiscoveryPopoverProps["onTogglePrompt"];
  readonly onReadResource: McpDiscoveryPopoverProps["onReadResource"];
}) {
  const togglable = items.filter((i) => i.kind !== "resource");
  const enabledCount = togglable.filter(isItemActive).length;
  const allEnabled = togglable.length > 0 && enabledCount === togglable.length;

  const onToggleAll = (next: boolean) => {
    for (const item of togglable) {
      if (isItemActive(item) === next) continue;
      if (item.kind === "tool") onToggleTool(item.server.id, item.id, next);
      else if (item.kind === "prompt")
        onTogglePrompt(item.server.id, item.id, next);
    }
  };

  return (
    <div className="mcp-menu-subsection">
      <label className="mcp-menu-subsection-head">
        {togglable.length > 0 ? (
          <Switch
            checked={allEnabled}
            onChange={onToggleAll}
            ariaLabel={`Enable all in ${tag}`}
          />
        ) : (
          <span className="mcp-switch-pill" aria-hidden data-placeholder>
            <span className="mcp-switch-thumb" />
          </span>
        )}
        <span className="mcp-menu-subsection-name">{tag}</span>
        {togglable.length > 0 ? (
          <span className="mcp-menu-section-count">
            {enabledCount}/{togglable.length}
          </span>
        ) : (
          <span className="mcp-menu-section-count">{items.length}</span>
        )}
      </label>
      <ul className="mcp-tool-chips">
        {items.map((item) => {
          const active = isItemActive(item);
          const clickable = item.kind === "resource";
          const runState = clickable
            ? itemState[`${item.server.id}::resource::${item.id}`]
            : undefined;
          const running = runState === "running";
          const error =
            runState && typeof runState === "object" && "error" in runState
              ? runState.error
              : undefined;
          const title =
            error ?? item.description ?? (clickable ? item.id : undefined);
          const chipProps = {
            className: "mcp-tool-chip",
            "data-kind": item.kind,
            "data-off": active ? undefined : true,
            "data-running": running || undefined,
            "data-error": error ? true : undefined,
            title,
          } as const;
          if (clickable && item.resource) {
            return (
              <li key={`${item.kind}:${item.id}`} className="mcp-tool-chip-li">
                <button
                  type="button"
                  {...chipProps}
                  onClick={() =>
                    item.resource && onReadResource(item.server, item.resource)
                  }
                  disabled={running}
                >
                  {item.label}
                </button>
              </li>
            );
          }
          return (
            <li
              key={`${item.kind}:${item.id}`}
              className="mcp-tool-chip-li"
            >
              <span {...chipProps}>{item.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="mcp-switch-pill"
      data-on={checked || undefined}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="mcp-switch-thumb" aria-hidden />
    </button>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -- Built-in tools popover --------------------------------------------

interface BuiltinDiscoveryPopoverProps {
  readonly tools: readonly BuiltinToolDef[];
  readonly isEnabled: (name: string) => boolean;
  readonly enabledCount: number;
  readonly onToggle: (name: string, enabled: boolean) => void;
  readonly onClose: () => void;
  readonly popoverRef?: React.Ref<HTMLDivElement>;
}

/** Sibling of {@link McpDiscoveryPopover}, scoped to local Tauri-backed
 * tools (Read / Write / Edit / Glob / Grep). All tools default to enabled
 * — the toggle simply hides one from the model on subsequent sends. Reuses
 * the MCP menu's class names so the popover inherits the same visual
 * shell without bespoke styles. */
function BuiltinDiscoveryPopover({
  tools,
  isEnabled,
  enabledCount,
  onToggle,
  onClose,
  popoverRef,
}: BuiltinDiscoveryPopoverProps) {
  return (
    <div
      ref={popoverRef}
      className="mcp-menu"
      role="dialog"
      aria-label="Helix Core tools"
    >
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            Helix Core
            <span className="mcp-menu-count">
              {enabledCount}/{tools.length}
            </span>
          </div>
          <div className="mcp-menu-hint">
            Local Helix Core tools backed by the Rust runtime — File System
            (Read, Write, Edit, Glob, Grep) and Data (Read Excel, Analyse
            Data via Polars). Enabled by default; toggle individual chips
            or flip a group's master switch to opt out for the next send.
          </div>
        </div>
        <button
          type="button"
          className="mcp-menu-close"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="mcp-menu-groups">
        <section className="mcp-menu-section">
          <div className="mcp-menu-section-head">
            <span className="mcp-menu-section-name">Helix Core</span>
            <span className="mcp-menu-section-count">{tools.length}</span>
          </div>
          <div className="mcp-menu-subgroups">
            {bucketByGroup(tools).map(({ group, items }) => {
              const groupEnabled = items.filter((t) => isEnabled(t.name)).length;
              const allOn = groupEnabled === items.length;
              return (
                <div key={group} className="mcp-menu-subsection">
                  <label className="mcp-menu-subsection-head">
                    <Switch
                      checked={allOn}
                      onChange={(next) => {
                        for (const t of items) {
                          if (isEnabled(t.name) !== next) onToggle(t.name, next);
                        }
                      }}
                      ariaLabel={`Enable all ${BUILTIN_GROUP_LABEL[group]} tools`}
                    />
                    <span className="mcp-menu-subsection-name">
                      {BUILTIN_GROUP_LABEL[group]}
                    </span>
                    <span className="mcp-menu-section-count">
                      {groupEnabled}/{items.length}
                    </span>
                  </label>
                  <ul className="mcp-tool-chips">
                    {items.map((t) => {
                      const on = isEnabled(t.name);
                      return (
                        <li key={t.name} className="mcp-tool-chip-li">
                          <button
                            type="button"
                            className="mcp-tool-chip"
                            data-kind="tool"
                            data-off={on ? undefined : true}
                            title={t.description}
                            aria-pressed={on}
                            onClick={() => onToggle(t.name, !on)}
                          >
                            {t.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Bucket the catalogue by `group` while preserving catalogue order both
 * across groups and within them. Stable order means the popover doesn't
 * shift around on re-render. */
function bucketByGroup(
  tools: readonly BuiltinToolDef[],
): readonly { group: BuiltinToolGroup; items: BuiltinToolDef[] }[] {
  const map = new Map<BuiltinToolGroup, BuiltinToolDef[]>();
  for (const t of tools) {
    let bucket = map.get(t.group);
    if (!bucket) {
      bucket = [];
      map.set(t.group, bucket);
    }
    bucket.push(t);
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
}

function HammerIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m15 12-8.5 8.5a2.121 2.121 0 0 1-3-3L12 9" />
      <path d="M17.64 15 22 10.64" />
      <path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h2.47l2.26 1.91" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="11"
      height="11"
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

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function RefreshIcon() {
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
    >
      <path d="M21 12a9 9 0 1 1-3.6-7.2" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

// -- Model picker ----------------------------------------------------------

const EMPTY_TRANSCRIPT: readonly TranscriptMessage[] = [];

interface ModelChipProps {
  readonly activeModel: string | undefined;
  readonly models: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly fromEndpoint: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onPick: (model: string) => void;
  readonly onRefresh: () => void;
}

/** Inline model picker chip. The label shows the active model id (truncated)
 * and a chevron; clicking opens a popover with discovered models. When the
 * `/models` endpoint isn't reachable we fall back to the provider's default
 * model and surface the failure as a quiet hint inside the popover. */
function ModelChip({
  activeModel,
  models,
  isLoading,
  error,
  fromEndpoint,
  open,
  onToggle,
  onClose,
  onPick,
  onRefresh,
}: ModelChipProps) {
  return (
    <span className="model-chip-wrap">
      <button
        type="button"
        className="tool-chip model-chip"
        data-active={open || undefined}
        title={activeModel ? `Model: ${activeModel}` : "Pick a model"}
        onClick={onToggle}
      >
        <span className="tool-chip-icon" aria-hidden>
          <CpuIcon />
        </span>
        <span className="model-chip-label">
          {activeModel ?? "Pick a model"}
        </span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="model-menu" role="dialog" aria-label="Pick a model">
          <header className="mcp-menu-head">
            <div>
              <div className="mcp-menu-title">
                Models
                {models.length > 0 ? (
                  <span className="mcp-menu-count">{models.length}</span>
                ) : null}
              </div>
              <div className="mcp-menu-hint">
                {isLoading
                  ? "Fetching from /models…"
                  : fromEndpoint
                    ? "From provider /models endpoint"
                    : error
                      ? `/models unavailable — using provider default${
                          error ? ` (${error})` : ""
                        }`
                      : "No /models endpoint — using provider default"}
              </div>
            </div>
            <button
              type="button"
              className="mcp-menu-close"
              onClick={() => {
                onRefresh();
              }}
              aria-label="Refresh models"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="mcp-menu-close"
              onClick={onClose}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </header>
          {models.length === 0 ? (
            <p className="mcp-menu-empty">
              No models available. Set a default model on the provider in
              Settings → Providers.
            </p>
          ) : (
            <ul className="mcp-menu-items model-menu-items">
              {models.map((m) => (
                <li
                  key={m}
                  role="option"
                  aria-selected={m === activeModel}
                  className="mcp-menu-item mcp-menu-item-action"
                  data-active={m === activeModel || undefined}
                >
                  <button
                    type="button"
                    className="mcp-menu-item-body"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(m);
                    }}
                  >
                    <span className="mcp-menu-item-text">
                      <code className="mcp-menu-item-name">{m}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

function CpuIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
    </svg>
  );
}

// -- Context window indicator ----------------------------------------------

interface ContextUsageChipProps {
  readonly messages: readonly TranscriptMessage[];
  readonly pendingContext: readonly PendingContextEntry[];
  readonly modelId: string | undefined;
  readonly contextResetAt: string | undefined;
  readonly onReset?: () => void;
}

/** Estimate-and-show chip: how full the model's context window is right now,
 * based on the visible transcript plus any prompt/resource context the user
 * has cued up. Estimation is approximate (chars/4 + small per-message
 * overhead) — exact tokenization would mean shipping a tokenizer per provider.
 * Hidden until there's something to show; turns amber over 70%, red over 90%.
 *
 * Clicking the chip resets the model-side context — older messages stay
 * visible in the transcript but stop being sent to the model, dropping the
 * percentage back to 0 and freeing the window for fresh turns. */
function ContextUsageChip({
  messages,
  pendingContext,
  modelId,
  contextResetAt,
  onReset,
}: ContextUsageChipProps) {
  const { used, window } = useMemo(() => {
    const window = contextWindowFor(modelId);
    const sendable = contextResetAt
      ? messages.filter((m) => m.createdAt >= contextResetAt)
      : messages;
    let used = estimateMessageTokens(sendable);
    for (const ctx of pendingContext) used += estimateTokens(ctx.content);
    return { used, window };
  }, [messages, pendingContext, modelId, contextResetAt]);

  if (used <= 0) return null;
  const pct = Math.min(100, Math.round((used / window) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const title = onReset
    ? `${formatTokens(used)} / ${formatTokens(window)} tokens (estimate) — click to reset context`
    : `${formatTokens(used)} / ${formatTokens(window)} tokens (estimate)`;

  if (!onReset) {
    return (
      <span className="context-chip" data-tone={tone} title={title}>
        <span className="context-chip-bar" aria-hidden>
          <span className="context-chip-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="context-chip-pct">{pct}%</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="context-chip context-chip-reset"
      data-tone={tone}
      title={title}
      aria-label={`Reset context (${pct}% used)`}
      onClick={onReset}
    >
      <span className="context-chip-bar" aria-hidden>
        <span className="context-chip-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="context-chip-pct">{pct}%</span>
    </button>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

// -- Skills (slash invocation) ---------------------------------------------

/** Union of items that can appear in the slash popover. Skills come
 * from disk and ride a separate render pipeline; built-in commands
 * fire side effects directly inside the composer. Discriminated
 * tag rather than two parallel arrays so ordering, highlighting, and
 * keyboard navigation stay simple. */
type SlashItem =
  | { readonly kind: "skill"; readonly skill: Skill }
  | { readonly kind: "builtin"; readonly command: BuiltinSlashCommand };

const EMPTY_SLASH_ITEMS: readonly SlashItem[] = [];

interface SlashState {
  /** The portion after `/` and before the first space — what's being typed. */
  readonly query: string;
  /** Filtered candidates, in display order. Built-in commands first
   * (short, well-known list) so they're predictable to reach. */
  readonly candidates: readonly SlashItem[];
}

/** Detect whether the textarea contents start with a slash command and,
 * if so, filter the candidate list against the partial name. The menu
 * only appears while the user is still typing the name (no space yet)
 * — once they hit space they're in "arguments" territory and we hide
 * it. Built-in commands and skills share one filtered list. */
function parseSlash(
  text: string,
  skills: readonly Skill[],
  commands: readonly BuiltinSlashCommand[],
): SlashState | null {
  if (!text.startsWith("/")) return null;
  // Hide once the user typed a space — they're entering arguments now.
  const sliced = text.slice(1);
  if (/\s/.test(sliced)) return null;
  const query = sliced.toLowerCase();
  // Prefix matches rank above substring matches so the auto-highlighted
  // top item is the natural completion of what the user just typed
  // (`/cle` → `/clear` at top, not some skill containing "cle" mid-name).
  // Stable sort preserves source order within each rank.
  const rank = (name: string) =>
    name.toLowerCase().startsWith(query) ? 0 : 1;
  const builtinCandidates = commands
    .filter((c) => c.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map<SlashItem>((command) => ({ kind: "builtin", command }));
  const skillCandidates = skills
    .filter((s) => !s.error && s.userInvocable)
    .filter((s) => s.name.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map<SlashItem>((skill) => ({ kind: "skill", skill }));
  return { query, candidates: [...builtinCandidates, ...skillCandidates] };
}

/** Match `/skill-name [args]` against the loaded skill list. Returns the
 * resolved skill plus the raw argument string (everything after the first
 * whitespace) when one matches; otherwise `null`. Names match case-
 * insensitively but Claude Code's spec restricts skill names to lowercase
 * anyway, so this is mostly defensive. */
function matchSlashInvocation(
  text: string,
  skills: readonly Skill[],
): { skill: Skill; args: string } | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  if (!name) return null;
  const args = space === -1 ? "" : body.slice(space + 1);
  const skill = skills.find(
    (s) => !s.error && s.userInvocable && s.name.toLowerCase() === name,
  );
  if (!skill) return null;
  return { skill, args };
}

/** Build the system messages helix prepends for skill awareness:
 *
 * - Always include a one-shot "available skills" listing so the model can
 *   auto-discover relevant skills mid-conversation (parity with how
 *   Claude Desktop pre-loads `name + description` for every skill).
 * - When the user typed `/skill-name args`, additionally include the
 *   rendered SKILL.md body as a system message so the model has the full
 *   instructions for this turn.
 *
 * The user's transcript text is left untouched — they see what they typed,
 * the model sees the skill body in addition. */
async function buildSkillContext(
  userText: string,
  skills: readonly Skill[],
  render: (id: string, args: string) => Promise<string>,
  discoverable: readonly Skill[],
): Promise<string[]> {
  const out: string[] = [];

  if (discoverable.length > 0) {
    const lines = discoverable.map((s) => {
      const desc = s.description ?? "(no description)";
      const hint = s.argumentHint ? ` — usage: /${s.name} ${s.argumentHint}` : "";
      return `- /${s.name}: ${desc}${hint}`;
    });
    out.push(
      [
        "[helix skills · metadata]",
        "The user has these skills available. When a request matches one,",
        "follow the skill's instructions. The user can also invoke a skill",
        "directly with /skill-name args.",
        "",
        ...lines,
      ].join("\n"),
    );
  }

  const invocation = matchSlashInvocation(userText, skills);
  if (invocation) {
    try {
      const body = await render(invocation.skill.id, invocation.args);
      out.push(
        [
          `[helix skills · invoked: ${invocation.skill.name}]`,
          "The user explicitly invoked this skill. Follow its instructions",
          "verbatim for this turn.",
          "",
          body,
        ].join("\n"),
      );
    } catch (err) {
      out.push(
        `[helix skills · failed to render ${invocation.skill.name}]\n${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return out;
}

interface SkillsSlashMenuProps {
  readonly candidates: readonly SlashItem[];
  readonly highlight: number;
  readonly query: string;
  readonly onHover: (idx: number) => void;
  readonly onPick: (item: SlashItem) => void;
}

function SkillsSlashMenu({
  candidates,
  highlight,
  query,
  onHover,
  onPick,
}: SkillsSlashMenuProps) {
  if (candidates.length === 0) {
    return (
      <div className="mcp-menu" role="listbox" aria-label="Slash commands">
        <header className="mcp-menu-head">
          <div>
            <div className="mcp-menu-title">Commands</div>
            <div className="mcp-menu-hint">
              Nothing matches <code>/{query}</code>. Add a skill under{" "}
              <code>~/.claude/skills/</code> or your workspace's{" "}
              <code>.claude/skills/</code>.
            </div>
          </div>
        </header>
      </div>
    );
  }
  return (
    <div className="mcp-menu" role="listbox" aria-label="Slash commands">
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            Commands
            <span className="mcp-menu-count">{candidates.length}</span>
          </div>
          <div className="mcp-menu-hint">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Tab</Kbd>/<Kbd>↵</Kbd>{" "}
            insert · <Kbd>Esc</Kbd> dismiss
          </div>
        </div>
      </header>
      <ul className="mcp-menu-items">
        {candidates.map((item, idx) => {
          const key =
            item.kind === "skill"
              ? `skill:${item.skill.id}`
              : `builtin:${item.command.name}`;
          const name =
            item.kind === "skill" ? item.skill.name : item.command.name;
          const description =
            item.kind === "skill"
              ? item.skill.description
              : item.command.description;
          const argumentHint =
            item.kind === "skill" ? item.skill.argumentHint : undefined;
          const sourceLabel =
            item.kind === "skill"
              ? item.skill.source === "project"
                ? "project"
                : "user"
              : "built-in";
          return (
            <li
              key={key}
              role="option"
              aria-selected={idx === highlight}
              className="mcp-menu-item mcp-menu-item-action"
              data-active={idx === highlight || undefined}
            >
              <button
                type="button"
                className="mcp-menu-item-body"
                onMouseEnter={() => onHover(idx)}
                onMouseDown={(e) => {
                  // mousedown so the click registers before the textarea
                  // blurs and the menu unmounts.
                  e.preventDefault();
                  onPick(item);
                }}
              >
                <span className="mcp-menu-item-text">
                  <code className="mcp-menu-item-name">/{name}</code>
                  {argumentHint ? (
                    <span className="mcp-menu-item-meta"> {argumentHint}</span>
                  ) : null}
                  {description ? (
                    <span className="mcp-menu-item-desc">{description}</span>
                  ) : null}
                  <span className="mcp-menu-item-meta">{sourceLabel}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
