import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button, Kbd } from "../../../components/ui";
import { BuiltinPalette } from "../builtin-palette";
import { McpPalette, type ServerGroup } from "../mcp-palette";
import { useMcpServers } from "../../../hooks/use-mcp-servers";
import { useMcpEnabledTags } from "../../../hooks/use-mcp-enabled-tags";
import { useModels } from "../../../hooks/use-models";
import { useProxy } from "../../../hooks/use-proxy";
import { useSkills } from "../../../hooks/use-skills";
import { useSystemPrompt } from "../../../hooks/use-system-prompt";
import type { ChatExtras, McpToolBinding } from "../../../hooks/use-chat";
import type { ProviderConfig } from "../../providers";
import {
  BUILTIN_SERVER_ID,
  BUILTIN_SLASH_COMMANDS,
  setBuiltinUiHandlers,
  useBuiltinTools,
} from "../../../lib/builtin-tools";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
  McpServerRuntime,
  McpToolInfo,
  TranscriptMessage,
} from "../../../app/types";
import { ContextUsageChip } from "./context-usage-chip";
import { HammerIcon, PlusIcon, SendIcon, StopIcon, WrenchIcon } from "./icons";
import { ModelChip } from "./model-chip";
import {
  buildWorkspaceContext,
  contextHeader,
  itemEnabledByTags,
  type PendingContextEntry,
} from "./pending-context";
import { SystemPromptPopover } from "./system-prompt-popover";
import {
  buildSkillContext,
  EMPTY_SLASH_ITEMS,
  parseSlash,
  SkillsSlashMenu,
  type SlashItem,
  type SlashState,
} from "./slash-menu";
import { ToolChip } from "./tool-chip";
import { writeLatestAssistantToWorkspace } from "./workspace-export";

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

/** Imperative surface the parent (App) reaches into when the user clicks a
 * file in the workspace panel. Kept narrow — anything broader belongs as
 * a regular prop. */
export interface ComposerHandle {
  /** Push a workspace file into pending context. `relPath` is what the user
   * sees on the chip; `absPath` is what the model is told the file lives at
   * (matches the `read_file` tool's resolved-path output). */
  attachWorkspaceFile: (args: {
    readonly absPath: string;
    readonly relPath: string;
    readonly content: string;
  }) => void;
}

type ChipKind = "tools" | "prompts" | "resources";

const EMPTY_TRANSCRIPT: readonly TranscriptMessage[] = [];

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
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
  },
  ref,
) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState<boolean>(false);
  const [builtinOpen, setBuiltinOpen] = useState<boolean>(false);
  const [modelMenuOpen, setModelMenuOpen] = useState<boolean>(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState<boolean>(false);
  const { systemPrompt, setSystemPrompt } = useSystemPrompt();
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
  const systemPromptTriggerRef = useRef<HTMLButtonElement>(null);
  const systemPromptPopoverRef = useRef<HTMLDivElement>(null);
  const canSend =
    text.trim().length > 0 && !disabled && !isStreaming && !!activeModel;

  const { servers, runtime } = useMcpServers();
  const { isTagEnabled } = useMcpEnabledTags();
  const { skills, render: renderSkill } = useSkills();
  const builtinTools = useBuiltinTools();
  const { config: proxyConfig } = useProxy();

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

  // Same dismiss handler for the system-prompt editor popover.
  useEffect(() => {
    if (!systemPromptOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (systemPromptTriggerRef.current?.contains(target)) return;
      if (systemPromptPopoverRef.current?.contains(target)) return;
      setSystemPromptOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [systemPromptOpen]);

  // Register the React-side clear handler, the active workspace folder,
  // and the corporate proxy snapshot so the built-in tool dispatcher can
  // reach them. Module-level registry avoids threading these through the
  // agent loop, which has no business knowing about UI affordances, the
  // workspace concept, or proxy plumbing.
  useEffect(() => {
    setBuiltinUiHandlers({
      clearTranscript: onClearTranscript,
      workspacePath,
      proxyConfig,
    });
    return () =>
      setBuiltinUiHandlers({
        clearTranscript: undefined,
        workspacePath: undefined,
        proxyConfig: undefined,
      });
  }, [onClearTranscript, workspacePath, proxyConfig]);

  /** Discoverable skills shown to the model on every send. Mirrors Claude
   * Desktop's "metadata always pre-loaded" behaviour: name + description
   * for every skill that hasn't opted out of model invocation. The full
   * body is only injected when the user explicitly invokes one with `/`. */
  const discoverableSkills = useMemo(
    () => skills.filter((s) => !s.disableModelInvocation && !s.error),
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
        (acc, g) =>
          acc +
          g.items.filter((t) => itemEnabledByTags(t.tags, isTagEnabled))
            .length,
        0,
      ),
      prompts: groups.prompts.reduce(
        (acc, g) =>
          acc +
          g.items.filter((p) => itemEnabledByTags(p.tags, isTagEnabled))
            .length,
        0,
      ),
      resources: groups.resources.reduce(
        (acc, g) => acc + g.items.length,
        0,
      ),
    }),
    [groups, isTagEnabled],
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

  /** Add a prompt / resource / file to the hidden context cart for the
   * next send. No-op when the same item is already pending (idempotent
   * click). File entries jump to the front of the queue so the model sees
   * them as its first instruction — same intent as Claude Code's "I just
   * pasted this file, look here first" pattern. */
  const addPendingContext = useCallback((entry: PendingContextEntry) => {
    setPendingContext((prev) => {
      if (prev.some((p) => p.id === entry.id)) return prev;
      if (entry.kind === "file") {
        // Most-recent file wins position 0; earlier files (and any non-file
        // entries) follow. Keeps "click the file, it becomes the first
        // instruction" obvious in the popover.
        return [entry, ...prev];
      }
      return [...prev, entry];
    });
  }, []);

  const removePendingContext = useCallback((id: string) => {
    setPendingContext((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // Imperative handle for the workspace panel: clicking a file there pushes
  // it into pending context as if the model had called `read_file`. The
  // header points at that tool name so the model can correlate the inline
  // content with later tool-call results if it chooses to re-read.
  useImperativeHandle(
    ref,
    () => ({
      attachWorkspaceFile: ({ absPath, relPath, content }) => {
        addPendingContext({
          id: `file:${absPath}`,
          kind: "file",
          serverName: "Workspace",
          label: relPath,
          content: contextHeader("file", "read_file", absPath) + content,
        });
      },
    }),
    [addPendingContext],
  );

  /** Fetch every prompt the user has effectively enabled (any of its tags
   * is on across all connected servers) and concatenate the results into
   * a list of system messages. Called from `submit` so each send sees
   * fresh content — if a prompt changes server-side, the next message
   * picks it up automatically. */
  const fetchEnabledPromptContext = async (): Promise<string[]> => {
    const targets: { server: McpServerConfig; prompt: McpPromptInfo }[] = [];
    for (const group of groups.prompts) {
      for (const prompt of group.items) {
        if (itemEnabledByTags(prompt.tags, isTagEnabled)) {
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
          const content = result.messages.map((m) => m.content).join("\n\n");
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

  const onReadResource = useCallback(
    async (server: McpServerConfig, resource: McpResourceInfo) => {
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
    },
    [pendingContext, addPendingContext],
  );

  /** Build the McpToolBinding list passed to the chat hook. A tool is
   * exposed to the model when any of its advertised tags is currently
   * enabled (or when it's untagged and the user hasn't explicitly
   * disabled the "untagged" bucket). Built-in tools (Read / Write / Edit
   * / Glob / Grep) ride the same list with a sentinel server id;
   * `useChat`'s dispatcher routes them to the Tauri backend instead of
   * an MCP transport. */
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
      for (const tool of group.items) {
        if (!itemEnabledByTags(tool.tags, isTagEnabled)) continue;
        out.push({
          serverId: group.server.id,
          toolName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }, [groups.tools, builtinTools, isTagEnabled]);

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
      await writeLatestAssistantToWorkspace(messages, workspacePath, setNotice);
      return;
    }
    if (!canSend) return;
    // Snapshot text + clear immediately so the textarea feels responsive
    // while we round-trip to MCP for prompt content.
    const userText = text;
    setText("");
    const attachments = pendingContext;
    // File attachments lead the context — when the user clicks a file in
    // the workspace pane, the file content becomes the model's first
    // instruction. Other one-shot entries (MCP prompt/resource, custom
    // notes) sit after persona / workspace pinning so they're closer to
    // the user message they're modifying.
    const fileContext = attachments
      .filter((p) => p.kind === "file")
      .map((p) => p.content);
    const otherOneShotContext = attachments
      .filter((p) => p.kind !== "file")
      .map((p) => p.content);
    setPendingContext([]);

    const promptContext = await fetchEnabledPromptContext();
    const skillContext = await buildSkillContext(
      userText,
      skills,
      renderSkill,
      discoverableSkills,
      attachments,
    );
    const workspaceContext = buildWorkspaceContext(workspacePath);
    // User-edited override sets the model's persona; empty / whitespace
    // is dropped so an unset prompt stays a no-op rather than a literal
    // empty system message.
    const systemPromptContext: string[] = systemPrompt.trim().length
      ? [systemPrompt.trim()]
      : [];

    const extras: ChatExtras = {
      // Order: clicked-file content → user persona → workspace pin →
      // persistent prompts → one-shot resources/notes → skill body
      // (closest to the user's text). Files lead so the model has the
      // primary material in its working set before any framing instruction
      // shifts its behavior.
      systemContext: [
        ...fileContext,
        ...systemPromptContext,
        ...workspaceContext,
        ...promptContext,
        ...otherOneShotContext,
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
  const onPickSlashItem = useCallback((item: SlashItem) => {
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
  }, []);

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
        {pendingContext.length > 0 ? (
          <div className="composer-context" role="list" aria-label="Attached context">
            <span className="composer-context-leadin" aria-hidden>
              Attached
            </span>
            {pendingContext.map((entry) => (
              <PendingContextChip
                key={entry.id}
                entry={entry}
                onRemove={() => removePendingContext(entry.id)}
              />
            ))}
          </div>
        ) : null}
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
          <ToolChip
            buttonRef={systemPromptTriggerRef}
            icon={<PlusIcon />}
            label="Context"
            count={
              systemPrompt.trim().length > 0
                ? pendingContext.length + 1
                : pendingContext.length || undefined
            }
            active={
              systemPromptOpen ||
              systemPrompt.trim().length > 0 ||
              pendingContext.length > 0
            }
            tooltip={
              pendingContext.length > 0 || systemPrompt.trim().length > 0
                ? "View, edit, or add context for the next message"
                : "Add a system prompt or notes for the model"
            }
            onClick={() => setSystemPromptOpen((v) => !v)}
          />
          <span className="composer-tools-spacer" />
          <ContextUsageChip
            messages={messages ?? EMPTY_TRANSCRIPT}
            pendingContext={pendingContext}
            modelId={activeModel}
            contextResetAt={contextResetAt}
            onReset={onResetContext}
          />
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

        {open && anyConnected ? (
          <McpPalette
            popoverRef={mcpPopoverRef}
            tools={groups.tools}
            prompts={groups.prompts}
            resources={groups.resources}
            itemState={itemState}
            onClose={() => setOpen(false)}
            onReadResource={onReadResource}
          />
        ) : null}

        {builtinOpen ? (
          <BuiltinPalette
            popoverRef={builtinPopoverRef}
            tools={builtinTools.tools}
            isEnabled={builtinTools.isEnabled}
            onToggle={builtinTools.setEnabled}
            onClose={() => setBuiltinOpen(false)}
          />
        ) : null}

        {systemPromptOpen ? (
          <SystemPromptPopover
            popoverRef={systemPromptPopoverRef}
            systemPrompt={systemPrompt}
            onSaveSystemPrompt={setSystemPrompt}
            pendingContext={pendingContext}
            onAddContext={addPendingContext}
            onRemoveContext={removePendingContext}
            onClose={() => setSystemPromptOpen(false)}
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
              isStreaming ? "Streaming…" : "Ask anything, or / for skills"
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
});

/* ---- Pending-context chip --------------------------------------------- */

interface PendingContextChipProps {
  readonly entry: PendingContextEntry;
  readonly onRemove: () => void;
}

function PendingContextChip({ entry, onRemove }: PendingContextChipProps) {
  const isFile = entry.kind === "file";
  const title = isFile
    ? `${entry.label}\nAttached via read_file — sent as the first system instruction on the next message.`
    : entry.kind === "custom"
      ? `${entry.label}\nCustom note — sent as system context on the next message.`
      : `${entry.kind === "prompt" ? "Prompt" : "Resource"} from ${entry.serverName} — sent as system context on the next message.`;

  return (
    <span
      role="listitem"
      className="composer-context-chip"
      data-kind={entry.kind}
      title={title}
    >
      <span className="composer-context-icon" aria-hidden>
        <ContextChipIcon kind={entry.kind} />
      </span>
      <span className="composer-context-kind">{kindLabel(entry.kind)}</span>
      <span className="composer-context-label">
        {isFile ? basenameOf(entry.label) : entry.label}
      </span>
      <button
        type="button"
        className="composer-context-remove"
        onClick={onRemove}
        aria-label={`Remove ${entry.label}`}
        title="Remove from context"
      >
        ×
      </button>
    </span>
  );
}

function kindLabel(kind: PendingContextEntry["kind"]): string {
  switch (kind) {
    case "file":
      return "file";
    case "prompt":
      return "prompt";
    case "resource":
      return "resource";
    case "custom":
      return "note";
  }
}

function basenameOf(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, "");
  const sep = cleaned.lastIndexOf("/");
  return sep < 0 ? cleaned : cleaned.slice(sep + 1);
}

function ContextChipIcon({
  kind,
}: {
  readonly kind: PendingContextEntry["kind"];
}) {
  if (kind === "file") {
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    );
  }
  if (kind === "custom") {
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
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z" />
      </svg>
    );
  }
  // Prompt / resource — generic doc icon, color-coded via the chip kind.
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
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M8 12h8M8 17h5" />
    </svg>
  );
}
