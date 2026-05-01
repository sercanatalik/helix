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
import { useSkills } from "../../hooks/use-skills";
import type { ChatExtras, McpToolBinding } from "../../hooks/use-chat";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
  McpServerRuntime,
  McpToolInfo,
  Skill,
} from "../../app/types";

interface ComposerProps {
  /** Send a user message. The `extras` payload carries hidden context the
   * model should see this turn — selected MCP prompts/resources as system
   * messages, and the set of MCP tools the model may call. None of it
   * appears in the transcript. */
  readonly onSend: (text: string, extras: ChatExtras) => void;
  readonly disabled?: boolean;
  readonly hint?: string;
  readonly modelLabel?: string;
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

const CHIP_LABELS: Readonly<Record<ChipKind, string>> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
};

interface ServerGroup<T> {
  readonly server: McpServerConfig;
  readonly items: readonly T[];
  readonly listError: string | undefined;
}

export function Composer({
  onSend,
  disabled = false,
  hint,
  modelLabel,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState<ChipKind | null>(null);
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
  const canSend = text.trim().length > 0 && !disabled;

  const { servers, runtime, setToolEnabled, setPromptEnabled } =
    useMcpServers();
  const { skills, render: renderSkill } = useSkills();

  // Slash-command parser. The user types `/skill-name args…`; we open a
  // filterable popover as soon as the textarea opens with `/` so they can
  // pick an entry without typing the full name. `null` means no menu.
  const slash = useMemo<SlashState | null>(
    () => parseSlash(text, skills),
    [text, skills],
  );
  // Highlight index for keyboard navigation within the slash popover.
  const [slashHighlight, setSlashHighlight] = useState(0);
  const slashCandidates = slash?.candidates ?? EMPTY_SKILL_LIST;
  // Snap the highlight back to the first row whenever the candidate set
  // changes — easier than threading the index through `parseSlash`.
  useEffect(() => {
    setSlashHighlight(0);
  }, [slash?.query, slashCandidates.length]);

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

  const toggle = (kind: ChipKind) => {
    if (!anyConnected) return;
    setOpen((curr) => (curr === kind ? null : kind));
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
      setOpen(null);
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
      setOpen(null);
    } catch (err) {
      setItemError(key, err instanceof Error ? err.message : String(err));
    }
  };

  /** Persistent indicators for prompts the user has toggled on. Same chip
   * style as one-shot resources, but the × calls back into the toggle so the
   * change persists in `enabledPrompts`. Recomputed on every server-state
   * push so toggles applied from anywhere stay in sync. */
  const enabledPromptChips = useMemo(() => {
    const out: { id: string; serverId: string; promptName: string; serverName: string }[] = [];
    for (const group of groups.prompts) {
      const enabled = new Set(group.server.enabledPrompts ?? []);
      for (const prompt of group.items) {
        if (enabled.has(prompt.name)) {
          out.push({
            id: `prompt:${group.server.id}:${prompt.name}`,
            serverId: group.server.id,
            promptName: prompt.name,
            serverName: group.server.name,
          });
        }
      }
    }
    return out;
  }, [groups.prompts]);

  /** Build the McpToolBinding list passed to the chat hook. We include every
   * advertised tool from a *connected* server that hasn't been disabled by
   * the user — so the toggle in the menu controls model visibility directly. */
  const mcpToolBindings = useMemo<readonly McpToolBinding[]>(() => {
    const out: McpToolBinding[] = [];
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
  }, [groups.tools]);

  async function submit() {
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

    const extras: ChatExtras = {
      // Persistent prompt context goes first so it grounds the rest of the
      // turn; one-shot resources follow as additional context. Skill
      // context comes last so the rendered SKILL.md body is the closest
      // system message to the user's text — same ordering Claude Code uses.
      systemContext: [
        ...promptContext,
        ...oneShotContext,
        ...skillContext,
      ],
      mcpTools: mcpToolBindings,
    };
    onSend(userText, extras);
  }

  /** Apply a skill the user picked from the slash popover. Replaces the
   * current `/query` prefix with `/skill-name ` so they can immediately
   * type arguments — same UX shape as Claude Code. */
  const onPickSkill = useCallback(
    (skill: Skill) => {
      const next = `/${skill.name} `;
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
      if (e.key === "Tab") {
        e.preventDefault();
        const pick = slashCandidates[slashHighlight];
        if (pick) onPickSkill(pick);
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
        {hint ? <div className="composer-status">{hint}</div> : null}
        <div className="composer-tools">
          <ToolChip
            icon={<WrenchIcon />}
            label="Tools"
            count={`${counts.tools}/${totals.tools}`}
            active={open === "tools"}
            disabled={!anyConnected}
            onClick={() => toggle("tools")}
          />
          <ToolChip
            icon={<SparkleIcon />}
            label="Prompts"
            count={`${counts.prompts}/${totals.prompts}`}
            active={open === "prompts"}
            disabled={!anyConnected}
            onClick={() => toggle("prompts")}
          />
          <ToolChip
            icon={<DatabaseIcon />}
            label="Resources"
            count={counts.resources}
            active={open === "resources"}
            disabled={!anyConnected}
            onClick={() => toggle("resources")}
          />
          <span className="composer-tools-spacer" />
          {modelLabel ? (
            <span className="composer-active-model">{modelLabel}</span>
          ) : null}
        </div>

        {enabledPromptChips.length > 0 || pendingContext.length > 0 ? (
          <div className="composer-context" role="list">
            {enabledPromptChips.map((chip) => (
              <span
                key={chip.id}
                role="listitem"
                className="composer-context-chip"
                data-kind="prompt"
                title={`Prompt from ${chip.serverName} — re-fetched and injected as hidden system context every message. Click × to disable.`}
              >
                <span className="composer-context-kind">prompt</span>
                <span className="composer-context-label">{chip.promptName}</span>
                <button
                  type="button"
                  className="composer-context-remove"
                  onClick={() =>
                    void setPromptEnabled(chip.serverId, chip.promptName, false)
                  }
                  aria-label={`Disable prompt ${chip.promptName}`}
                >
                  ×
                </button>
              </span>
            ))}
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

        {open !== null && anyConnected ? (
          <McpDiscoveryPopover
            kind={open}
            groups={
              open === "tools"
                ? groups.tools
                : open === "prompts"
                  ? groups.prompts
                  : groups.resources
            }
            itemState={itemState}
            onClose={() => setOpen(null)}
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

        <div className="composer-card">
          {slash ? (
            <SkillsSlashMenu
              candidates={slashCandidates}
              highlight={slashHighlight}
              query={slash.query}
              onHover={setSlashHighlight}
              onPick={onPickSkill}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              disabled
                ? "Streaming…"
                : "Message the assistant. Type / for skills."
            }
            rows={1}
            disabled={disabled}
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
            <Button disabled={!canSend} onClick={() => void submit()}>
              Send
              <SendIcon />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
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
}

function ToolChip({
  icon,
  label,
  count,
  active,
  disabled,
  onClick,
}: ToolChipProps) {
  return (
    <button
      type="button"
      className="tool-chip"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      title={
        disabled
          ? `${label} — connect an MCP server in Settings → MCP`
          : `${label} from connected MCP servers`
      }
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
  readonly kind: ChipKind;
  readonly groups: readonly (
    | ServerGroup<McpToolInfo>
    | ServerGroup<McpPromptInfo>
    | ServerGroup<McpResourceInfo>
  )[];
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
}

function McpDiscoveryPopover({
  kind,
  groups,
  itemState,
  onClose,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
}: McpDiscoveryPopoverProps) {
  const totalAdvertised = groups.reduce(
    (acc, g) => acc + g.items.length,
    0,
  );
  const headerHint =
    kind === "tools"
      ? "Toggle which tools the assistant can call."
      : kind === "prompts"
        ? "Toggle prompts on to inject them as hidden context every turn."
        : "Click a resource to fetch and attach its contents.";

  return (
    <div
      className="mcp-menu"
      role="dialog"
      aria-label={`Connected MCP ${CHIP_LABELS[kind]}`}
    >
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            {capitalize(CHIP_LABELS[kind])}
            <span className="mcp-menu-count">{totalAdvertised}</span>
          </div>
          <div className="mcp-menu-hint">{headerHint}</div>
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

      {totalAdvertised === 0 && groups.every((g) => !g.listError) ? (
        <p className="mcp-menu-empty">
          Connected, but no {CHIP_LABELS[kind]} were advertised by any server.
        </p>
      ) : kind === "tools" ? (
        <ToolsByTag
          groups={groups as readonly ServerGroup<McpToolInfo>[]}
          onToggleTool={onToggleTool}
        />
      ) : kind === "prompts" ? (
        <PromptsByTag
          groups={groups as readonly ServerGroup<McpPromptInfo>[]}
          onTogglePrompt={onTogglePrompt}
        />
      ) : (
        <div className="mcp-menu-groups">
          {groups.map((group) => (
            <ServerSection
              key={group.server.id}
              kind={kind}
              group={group}
              itemState={itemState}
              onToggleTool={onToggleTool}
              onTogglePrompt={onTogglePrompt}
              onReadResource={onReadResource}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerSection({
  kind,
  group,
  itemState,
  onToggleTool,
  onTogglePrompt,
  onReadResource,
}: {
  readonly kind: ChipKind;
  readonly group:
    | ServerGroup<McpToolInfo>
    | ServerGroup<McpPromptInfo>
    | ServerGroup<McpResourceInfo>;
  readonly itemState: McpDiscoveryPopoverProps["itemState"];
  readonly onToggleTool: McpDiscoveryPopoverProps["onToggleTool"];
  readonly onTogglePrompt: McpDiscoveryPopoverProps["onTogglePrompt"];
  readonly onReadResource: McpDiscoveryPopoverProps["onReadResource"];
}) {
  if (group.items.length === 0 && !group.listError) {
    return null;
  }
  return (
    <section className="mcp-menu-section">
      <div className="mcp-menu-section-head">
        <span className="mcp-menu-section-name">{group.server.name}</span>
        <span className="mcp-menu-section-count">{group.items.length}</span>
      </div>
      {group.listError ? (
        <p className="mcp-menu-section-error">
          <strong>{CHIP_LABELS[kind]}/list</strong>: {group.listError}
        </p>
      ) : (
        <ul className="mcp-menu-items">
          {kind === "tools"
            ? (group.items as readonly McpToolInfo[]).map((tool) => (
                <ToolItem
                  key={tool.name}
                  server={group.server}
                  tool={tool}
                  onToggle={onToggleTool}
                />
              ))
            : kind === "prompts"
              ? (group.items as readonly McpPromptInfo[]).map((prompt) => (
                  <PromptItem
                    key={prompt.name}
                    server={group.server}
                    prompt={prompt}
                    onToggle={onTogglePrompt}
                  />
                ))
              : (group.items as readonly McpResourceInfo[]).map(
                  (resource) => (
                    <ResourceItem
                      key={resource.uri}
                      server={group.server}
                      resource={resource}
                      state={itemState[`${group.server.id}::resource::${resource.uri}`]}
                      onRead={onReadResource}
                    />
                  ),
                )}
        </ul>
      )}
    </section>
  );
}

function ToolItem({
  server,
  tool,
  showServerName = false,
  onToggle,
}: {
  readonly server: McpServerConfig;
  readonly tool: McpToolInfo;
  /** When the surrounding section isn't already scoped to one server (e.g.
   * the tag-grouped view), prefix the tool name with its server so duplicate
   * tool names across servers stay distinguishable. */
  readonly showServerName?: boolean;
  readonly onToggle: (
    serverId: string,
    toolName: string,
    nextEnabled: boolean,
  ) => void;
}) {
  const enabled = isToolEnabled(server, tool.name);
  return (
    <li className="mcp-menu-item mcp-menu-item-toggle">
      <label className="mcp-menu-toggle-row">
        <Switch
          checked={enabled}
          onChange={(next) => onToggle(server.id, tool.name, next)}
          ariaLabel={`Enable tool ${tool.name}`}
        />
        <span className="mcp-menu-toggle-label">
          {showServerName ? (
            <span className="mcp-menu-item-server">{server.name}·</span>
          ) : null}
          <code className="mcp-menu-item-name">{tool.name}</code>
          {tool.description ? (
            <>
              <span className="mcp-menu-item-sep"> — </span>
              <span className="mcp-menu-item-desc-inline">
                {tool.description}
              </span>
            </>
          ) : null}
        </span>
      </label>
    </li>
  );
}

const UNTAGGED = "Untagged";

interface TagBucket<T> {
  readonly tag: string;
  readonly entries: ReadonlyArray<{
    readonly server: McpServerConfig;
    readonly item: T;
  }>;
}

/** Bucket every (server, item) pair under each of its tags. An item with N
 * tags appears in N buckets; an item with no tags lands in `Untagged`. Tag
 * buckets are sorted alphabetically with `Untagged` last. */
function bucketByTag<T>(
  groups: readonly ServerGroup<T>[],
  getTags: (item: T) => readonly string[] | undefined,
): readonly TagBucket<T>[] {
  const buckets = new Map<string, Array<{ server: McpServerConfig; item: T }>>();
  for (const group of groups) {
    for (const item of group.items) {
      const t = getTags(item);
      const tags = t && t.length > 0 ? t : [UNTAGGED];
      for (const tag of tags) {
        let list = buckets.get(tag);
        if (!list) {
          list = [];
          buckets.set(tag, list);
        }
        list.push({ server: group.server, item });
      }
    }
  }
  return Array.from(buckets.entries())
    .map(([tag, entries]) => ({ tag, entries }))
    .sort((a, b) => {
      if (a.tag === UNTAGGED) return 1;
      if (b.tag === UNTAGGED) return -1;
      return a.tag.localeCompare(b.tag);
    });
}

function ToolsByTag({
  groups,
  onToggleTool,
}: {
  readonly groups: readonly ServerGroup<McpToolInfo>[];
  readonly onToggleTool: (
    serverId: string,
    toolName: string,
    nextEnabled: boolean,
  ) => void;
}) {
  const buckets = useMemo(
    () => bucketByTag(groups, (t) => t.tags),
    [groups],
  );
  const errored = groups.filter((g) => g.listError);
  return (
    <div className="mcp-menu-groups">
      {errored.map((g) => (
        <p key={g.server.id} className="mcp-menu-section-error">
          <strong>{g.server.name} · tools/list</strong>: {g.listError}
        </p>
      ))}
      {buckets.map(({ tag, entries }) => (
        <section key={tag} className="mcp-menu-section">
          <div className="mcp-menu-section-head">
            <span className="mcp-menu-section-name">{tag}</span>
            <span className="mcp-menu-section-count">{entries.length}</span>
          </div>
          <ul className="mcp-menu-items">
            {entries.map(({ server, item }) => (
              <ToolItem
                key={`${server.id}::${item.name}`}
                server={server}
                tool={item}
                showServerName
                onToggle={onToggleTool}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PromptsByTag({
  groups,
  onTogglePrompt,
}: {
  readonly groups: readonly ServerGroup<McpPromptInfo>[];
  readonly onTogglePrompt: (
    serverId: string,
    promptName: string,
    nextEnabled: boolean,
  ) => void;
}) {
  const buckets = useMemo(
    () => bucketByTag(groups, (p) => p.tags),
    [groups],
  );
  const errored = groups.filter((g) => g.listError);
  return (
    <div className="mcp-menu-groups">
      {errored.map((g) => (
        <p key={g.server.id} className="mcp-menu-section-error">
          <strong>{g.server.name} · prompts/list</strong>: {g.listError}
        </p>
      ))}
      {buckets.map(({ tag, entries }) => (
        <section key={tag} className="mcp-menu-section">
          <div className="mcp-menu-section-head">
            <span className="mcp-menu-section-name">{tag}</span>
            <span className="mcp-menu-section-count">{entries.length}</span>
          </div>
          <ul className="mcp-menu-items">
            {entries.map(({ server, item }) => (
              <PromptItem
                key={`${server.id}::${item.name}`}
                server={server}
                prompt={item}
                showServerName
                onToggle={onTogglePrompt}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PromptItem({
  server,
  prompt,
  showServerName = false,
  onToggle,
}: {
  readonly server: McpServerConfig;
  readonly prompt: McpPromptInfo;
  /** When the surrounding section isn't already scoped to one server (e.g.
   * the tag-grouped view), prefix the prompt name with its server so
   * duplicate prompt names across servers stay distinguishable. */
  readonly showServerName?: boolean;
  readonly onToggle: (
    serverId: string,
    promptName: string,
    nextEnabled: boolean,
  ) => void;
}) {
  const enabled = isPromptEnabled(server, prompt.name);
  return (
    <li className="mcp-menu-item mcp-menu-item-toggle">
      <label className="mcp-menu-toggle-row">
        <Switch
          checked={enabled}
          onChange={(next) => onToggle(server.id, prompt.name, next)}
          ariaLabel={`Inject prompt ${prompt.name} as hidden context`}
        />
        <span className="mcp-menu-toggle-label">
          {showServerName ? (
            <span className="mcp-menu-item-server">{server.name}·</span>
          ) : null}
          <code className="mcp-menu-item-name">{prompt.name}</code>
          {prompt.description ? (
            <>
              <span className="mcp-menu-item-sep"> — </span>
              <span className="mcp-menu-item-desc-inline">
                {prompt.description}
              </span>
            </>
          ) : null}
          {prompt.arguments && prompt.arguments.length > 0 ? (
            <span className="mcp-menu-item-args">
              {" "}
              ({prompt.arguments.map((a) => a.name).join(", ")})
            </span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function ResourceItem({
  server,
  resource,
  state,
  onRead,
}: {
  readonly server: McpServerConfig;
  readonly resource: McpResourceInfo;
  readonly state: "running" | { error: string } | undefined;
  readonly onRead: (
    server: McpServerConfig,
    resource: McpResourceInfo,
  ) => void;
}) {
  const running = state === "running";
  const error =
    state && typeof state === "object" && "error" in state
      ? state.error
      : undefined;
  return (
    <li className="mcp-menu-item mcp-menu-item-action">
      <button
        type="button"
        className="mcp-menu-item-body"
        onClick={() => onRead(server, resource)}
        disabled={running}
      >
        <span className="mcp-menu-item-text">
          <code className="mcp-menu-item-name">{resource.uri}</code>
          {resource.name ? (
            <span className="mcp-menu-item-desc">{resource.name}</span>
          ) : null}
          {resource.mimeType ? (
            <span className="mcp-menu-item-meta">{resource.mimeType}</span>
          ) : null}
          {error ? <span className="mcp-menu-item-error">{error}</span> : null}
        </span>
        <span className="mcp-menu-item-action-trail">
          {running ? <Spinner /> : <ChevronRightIcon />}
        </span>
      </button>
    </li>
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

function SparkleIcon() {
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
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

function DatabaseIcon() {
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
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
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

function ChevronRightIcon() {
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
      <path d="m9 6 6 6-6 6" />
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

function Spinner() {
  return (
    <svg
      className="mcp-menu-spinner"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
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

// -- Skills (slash invocation) ---------------------------------------------

const EMPTY_SKILL_LIST: readonly Skill[] = [];

interface SlashState {
  /** The portion after `/` and before the first space — what's being typed. */
  readonly query: string;
  /** Filtered skills, in display order. */
  readonly candidates: readonly Skill[];
}

/** Detect whether the textarea contents start with a slash command and,
 * if so, filter the skill list against the partial name. The menu only
 * appears while the user is still typing the name (no space yet) — once
 * they hit space they're in "arguments" territory and we hide it. */
function parseSlash(text: string, skills: readonly Skill[]): SlashState | null {
  if (!text.startsWith("/")) return null;
  // Hide once the user typed a space — they're entering arguments now.
  const sliced = text.slice(1);
  if (/\s/.test(sliced)) return null;
  const query = sliced.toLowerCase();
  const visible = skills.filter((s) => !s.error && s.userInvocable);
  const candidates = visible.filter((s) =>
    s.name.toLowerCase().includes(query),
  );
  return { query, candidates };
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
  readonly candidates: readonly Skill[];
  readonly highlight: number;
  readonly query: string;
  readonly onHover: (idx: number) => void;
  readonly onPick: (skill: Skill) => void;
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
      <div className="mcp-menu" role="listbox" aria-label="Skills">
        <header className="mcp-menu-head">
          <div>
            <div className="mcp-menu-title">Skills</div>
            <div className="mcp-menu-hint">
              No skills match <code>/{query}</code>. Add one under{" "}
              <code>~/.claude/skills/</code> or your workspace's{" "}
              <code>.claude/skills/</code>.
            </div>
          </div>
        </header>
      </div>
    );
  }
  return (
    <div className="mcp-menu" role="listbox" aria-label="Skills">
      <header className="mcp-menu-head">
        <div>
          <div className="mcp-menu-title">
            Skills
            <span className="mcp-menu-count">{candidates.length}</span>
          </div>
          <div className="mcp-menu-hint">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> select · <Kbd>Tab</Kbd> insert ·{" "}
            <Kbd>Esc</Kbd> dismiss
          </div>
        </div>
      </header>
      <ul className="mcp-menu-items">
        {candidates.map((skill, idx) => (
          <li
            key={skill.id}
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
                onPick(skill);
              }}
            >
              <span className="mcp-menu-item-text">
                <code className="mcp-menu-item-name">/{skill.name}</code>
                {skill.argumentHint ? (
                  <span className="mcp-menu-item-meta">
                    {" "}
                    {skill.argumentHint}
                  </span>
                ) : null}
                {skill.description ? (
                  <span className="mcp-menu-item-desc">
                    {skill.description}
                  </span>
                ) : null}
                <span className="mcp-menu-item-meta">
                  {skill.source === "project" ? "project" : "user"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
