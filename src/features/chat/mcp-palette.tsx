import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { estimateTokens } from "../../lib/llm/context-window";
import {
  UNTAGGED_TAG,
  useMcpEnabledTags,
} from "../../hooks/use-mcp-enabled-tags";
import type {
  McpPromptInfo,
  McpResourceInfo,
  McpServerConfig,
  McpToolInfo,
} from "../../app/types";

/** A connected server's discovered items for one kind, with an optional
 * `list/*` error string when the server replied to discovery with an error.
 * Mirrors the shape composer.tsx already builds; kept duplicated here so the
 * palette has its own narrow contract. */
export interface ServerGroup<T> {
  readonly server: McpServerConfig;
  readonly items: readonly T[];
  readonly listError: string | undefined;
}

export type PaletteItemState = Readonly<
  Record<string, "running" | { error: string }>
>;

export interface McpPaletteProps {
  readonly tools: readonly ServerGroup<McpToolInfo>[];
  readonly prompts: readonly ServerGroup<McpPromptInfo>[];
  readonly resources: readonly ServerGroup<McpResourceInfo>[];
  readonly itemState: PaletteItemState;
  readonly onClose: () => void;
  readonly onReadResource: (
    server: McpServerConfig,
    resource: McpResourceInfo,
  ) => void;
  readonly popoverRef?: React.Ref<HTMLDivElement>;
}

type Kind = "tool" | "prompt" | "resource";

/** Search-first MCP toolbox grouped by tag. Items repeat under every tag
 * they carry — the same `chart_data` tool appears under both `#chart` and
 * `#data` if the server advertises it that way. Toggles are at the tag
 * level only: enabling a tag activates every item carrying it; an item
 * with N tags is "live" if any of its N tags is enabled.
 *
 * The user toggles capabilities, not individual functions. The cost
 * footer dedupes — an item enabled via two tags counts once. */
export function McpPalette({
  tools,
  prompts,
  resources,
  itemState,
  onClose,
  onReadResource,
  popoverRef,
}: McpPaletteProps) {
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { isTagEnabled, toggleTag } = useMcpEnabledTags();

  // ⌘. closes the palette (matches the model picker / slash menu's documented
  // keyboard contract). Auto-focus the search box on mount.
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "." && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Flatten every connected server's discovered items into one list. We
  // don't bucket here — that happens in `tagGroups` below — because the
  // same source list also feeds the cost footer's dedupe (one item, no
  // matter how many tags it carries, counts once toward the budget).
  const items = useMemo(
    () => collectItems(tools, prompts, resources),
    [tools, prompts, resources],
  );

  // Distinct tag names seen across every connected server, for the filter
  // chip row. Sorted alphabetically; the untagged sentinel slides to the
  // end so the visual rhythm matches the body groups below.
  const allTags = useMemo(() => collectTagSet(items), [items]);

  const tagGroups = useMemo(
    () => groupByTag(items, query),
    [items, query],
  );

  const errors: ReadonlyArray<{
    readonly server: McpServerConfig;
    readonly kind: string;
    readonly error: string;
  }> = useMemo(() => collectErrors(tools, prompts, resources), [
    tools,
    prompts,
    resources,
  ]);

  // Item-level dedupe: an item is "enabled" if any tag it carries is
  // enabled. Untagged items use the sentinel. The cost is a sum over
  // enabled items, regardless of how many tags they appear under.
  const cost = useMemo(() => {
    let enabled = 0;
    let off = 0;
    let tokens = 0;
    for (const item of items) {
      const tagList = item.tags.length > 0 ? item.tags : [UNTAGGED_TAG];
      const live = tagList.some((t) => isTagEnabled(t));
      if (live) {
        enabled++;
        tokens += item.approxTokens;
      } else {
        off++;
      }
    }
    return { enabled, off, tokens };
  }, [items, isTagEnabled]);

  const totalAdvertised = items.length;
  const empty = totalAdvertised === 0 && errors.length === 0;
  const visibleGroups = filterGroups(tagGroups, filter);

  return (
    <div
      ref={popoverRef}
      className="mcp-palette"
      role="dialog"
      aria-label="MCP toolbox"
    >
      <div className="mcp-palette-search">
        <span className="mcp-palette-search-icon" aria-hidden>
          ⌕
        </span>
        <input
          ref={inputRef}
          className="mcp-palette-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags, tools, prompts, resources…"
          aria-label="Search MCP items"
        />
        <span className="mcp-palette-kbd" aria-hidden>
          ⌘K
        </span>
      </div>

      <div className="mcp-palette-filters" role="tablist">
        <button
          type="button"
          role="tab"
          className="mcp-palette-filter"
          data-active={filter === "all" || undefined}
          aria-selected={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        {allTags.map((tag) => (
          <button
            key={tag}
            type="button"
            role="tab"
            className="mcp-palette-filter"
            data-tag
            data-active={filter === tag || undefined}
            aria-selected={filter === tag}
            onClick={() => setFilter(tag)}
          >
            {tag === UNTAGGED_TAG ? "untagged" : `#${tag}`}
          </button>
        ))}
        <span className="mcp-palette-filters-spacer" />
        <span className="mcp-palette-filters-meta">
          {countServers(items)}{" "}
          {countServers(items) === 1 ? "server" : "servers"}
        </span>
      </div>

      <div className="mcp-palette-body">
        {empty ? (
          <p className="mcp-palette-empty">
            Connected, but no tools, prompts, or resources were advertised.
          </p>
        ) : (
          <>
            {errors.map((e) => (
              <p
                key={`${e.server.id}::${e.kind}`}
                className="mcp-palette-error"
              >
                <strong>
                  {e.server.name} · {e.kind}/list
                </strong>
                : {e.error}
              </p>
            ))}
            {visibleGroups.map(({ tag, items: groupItems }) => (
              <PaletteTagGroup
                key={tag}
                tag={tag}
                items={groupItems}
                enabled={isTagEnabled(tag)}
                onToggle={toggleTag}
                itemState={itemState}
                onReadResource={onReadResource}
              />
            ))}
            {visibleGroups.length === 0 && !empty ? (
              <p className="mcp-palette-empty">No matches.</p>
            ) : null}
          </>
        )}
      </div>

      <div className="mcp-palette-footer" role="status">
        <span className="mcp-palette-footer-count">
          <span className="mcp-palette-footer-dot" aria-hidden />
          <b>{cost.enabled}</b> enabled
          <span className="mcp-palette-footer-sep">·</span>
          <span className="mcp-palette-footer-dim">{cost.off} off</span>
        </span>
        <span className="mcp-palette-footer-cost">
          <span className="mcp-palette-footer-dim">~</span>
          <b>{formatTokens(cost.tokens)}</b>
          <span className="mcp-palette-footer-dim">
            {" "}
            tok added to system prompt
          </span>
        </span>
        <span className="mcp-palette-footer-keys">
          <kbd>↵</kbd> toggle tag{" "}
          <span className="mcp-palette-footer-sep">·</span> <kbd>⌘.</kbd> close
        </span>
      </div>
    </div>
  );
}

interface PaletteItem {
  /** Stable identity per (server, kind, name|uri). The same item may be
   * displayed under multiple tags — the React key for each occurrence
   * adds the tag for uniqueness, but this id is what dedupes the cost
   * calculation. */
  readonly id: string;
  readonly server: McpServerConfig;
  readonly kind: Kind;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly resource?: McpResourceInfo;
  /** Token estimate for what this row contributes to the system prompt
   * when its tag is enabled. Tools count description + JSON schema;
   * prompts count description (full body fetched at send time);
   * resources are click-to-read so the schema overhead is zero. */
  readonly approxTokens: number;
}

function collectItems(
  tools: readonly ServerGroup<McpToolInfo>[],
  prompts: readonly ServerGroup<McpPromptInfo>[],
  resources: readonly ServerGroup<McpResourceInfo>[],
): readonly PaletteItem[] {
  const acc: PaletteItem[] = [];
  for (const g of tools) {
    for (const t of g.items) {
      const schema = t.inputSchema ? JSON.stringify(t.inputSchema) : "";
      acc.push({
        id: `${g.server.id}::tool::${t.name}`,
        server: g.server,
        kind: "tool",
        name: t.name,
        description: t.description ?? "",
        tags: t.tags ?? [],
        approxTokens:
          estimateTokens(t.description ?? "") + estimateTokens(schema),
      });
    }
  }
  for (const g of prompts) {
    for (const p of g.items) {
      acc.push({
        id: `${g.server.id}::prompt::${p.name}`,
        server: g.server,
        kind: "prompt",
        name: p.name,
        description: p.description ?? "",
        tags: p.tags ?? [],
        approxTokens: estimateTokens(p.description ?? ""),
      });
    }
  }
  for (const g of resources) {
    for (const r of g.items) {
      acc.push({
        id: `${g.server.id}::resource::${r.uri}`,
        server: g.server,
        kind: "resource",
        name: r.name || r.uri,
        description: r.mimeType ?? r.description ?? r.uri,
        tags: r.tags ?? [],
        resource: r,
        approxTokens: 0,
      });
    }
  }
  return acc;
}

function collectErrors(
  tools: readonly ServerGroup<McpToolInfo>[],
  prompts: readonly ServerGroup<McpPromptInfo>[],
  resources: readonly ServerGroup<McpResourceInfo>[],
): ReadonlyArray<{
  readonly server: McpServerConfig;
  readonly kind: string;
  readonly error: string;
}> {
  const list: Array<{
    server: McpServerConfig;
    kind: string;
    error: string;
  }> = [];
  for (const g of tools) {
    if (g.listError) {
      list.push({ server: g.server, kind: "tools", error: g.listError });
    }
  }
  for (const g of prompts) {
    if (g.listError) {
      list.push({ server: g.server, kind: "prompts", error: g.listError });
    }
  }
  for (const g of resources) {
    if (g.listError) {
      list.push({ server: g.server, kind: "resources", error: g.listError });
    }
  }
  return list;
}

function collectTagSet(items: readonly PaletteItem[]): readonly string[] {
  const set = new Set<string>();
  let hasUntagged = false;
  for (const item of items) {
    if (item.tags.length === 0) hasUntagged = true;
    for (const tag of item.tags) set.add(tag);
  }
  const arr = Array.from(set).sort((a, b) => a.localeCompare(b));
  if (hasUntagged) arr.push(UNTAGGED_TAG);
  return arr;
}

function countServers(items: readonly PaletteItem[]): number {
  const set = new Set<string>();
  for (const item of items) set.add(item.server.id);
  return set.size;
}

interface TagGroup {
  readonly tag: string;
  readonly items: readonly PaletteItem[];
}

function groupByTag(
  items: readonly PaletteItem[],
  query: string,
): readonly TagGroup[] {
  const q = query.trim().toLowerCase();
  const matches = (item: PaletteItem, tag: string) => {
    if (!q) return true;
    return (
      tag.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.server.name.toLowerCase().includes(q)
    );
  };
  const byTag = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const tagList = item.tags.length > 0 ? item.tags : [UNTAGGED_TAG];
    for (const tag of tagList) {
      if (!matches(item, tag)) continue;
      let bucket = byTag.get(tag);
      if (!bucket) {
        bucket = [];
        byTag.set(tag, bucket);
      }
      bucket.push(item);
    }
  }
  return Array.from(byTag.entries())
    .map(([tag, list]) => ({ tag, items: list }))
    .sort((a, b) => {
      if (a.tag === UNTAGGED_TAG) return 1;
      if (b.tag === UNTAGGED_TAG) return -1;
      return a.tag.localeCompare(b.tag);
    });
}

function filterGroups(
  groups: readonly TagGroup[],
  filter: string,
): readonly TagGroup[] {
  if (filter === "all") return groups;
  return groups.filter((g) => g.tag === filter);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const PaletteTagGroup = memo(function PaletteTagGroup({
  tag,
  items,
  enabled,
  onToggle,
  itemState,
  onReadResource,
}: {
  readonly tag: string;
  readonly items: readonly PaletteItem[];
  readonly enabled: boolean;
  readonly onToggle: (tag: string) => void;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
  const [open, setOpen] = useState(true);
  const isUntagged = tag === UNTAGGED_TAG;
  const label = isUntagged ? "untagged" : `#${tag}`;

  // Inside each tag group, items further bucket by kind. Empty kinds drop
  // out so a tag covering only tools doesn't render bare Prompts /
  // Resources headers.
  const byKind = useMemo(() => {
    const map: Record<Kind, PaletteItem[]> = {
      tool: [],
      prompt: [],
      resource: [],
    };
    for (const item of items) map[item.kind].push(item);
    return map;
  }, [items]);

  const handleToggle = useCallback(() => onToggle(tag), [onToggle, tag]);
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

  return (
    <section className="mcp-palette-group">
      <header className="mcp-palette-group-head">
        <button
          type="button"
          className="mcp-palette-group-toggle"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label={open ? "Collapse tag" : "Expand tag"}
        >
          <span
            className="mcp-palette-group-chev"
            data-open={open || undefined}
          >
            ▸
          </span>
        </button>
        <button
          type="button"
          className="mcp-palette-tag-pill"
          data-active={enabled || undefined}
          data-untagged={isUntagged || undefined}
          onClick={handleToggle}
          aria-pressed={enabled}
          title={enabled ? `Disable ${label}` : `Enable ${label}`}
        >
          {label}
        </button>
        <span className="mcp-palette-group-meta">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <span
          className="mcp-palette-group-marker"
          data-state={enabled ? "on" : "off"}
        >
          {enabled ? "on" : "off"}
        </span>
        <Switch
          checked={enabled}
          onChange={handleToggle}
          ariaLabel={`Toggle ${label}`}
        />
      </header>
      {open ? (
        <div className="mcp-palette-rows">
          {(["tool", "prompt", "resource"] as const).map((kind) => {
            const rows = byKind[kind];
            if (rows.length === 0) return null;
            return (
              <div key={kind} className="mcp-palette-kind">
                <div className="mcp-palette-kind-head" data-kind={kind}>
                  <span
                    className="mcp-palette-kind-dot"
                    aria-hidden
                  />
                  <span className="mcp-palette-kind-label">
                    {kindLabel(kind)}
                  </span>
                  <span className="mcp-palette-kind-count">
                    · {rows.length}
                  </span>
                </div>
                <ul className="mcp-palette-row-list" role="list">
                  {rows.map((row, idx) => (
                    <PaletteRowView
                      key={`${tag}::${row.id}::${idx}`}
                      row={row}
                      enabled={enabled}
                      itemState={itemState}
                      onReadResource={onReadResource}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
});

function kindLabel(kind: Kind): string {
  if (kind === "tool") return "Tools";
  if (kind === "prompt") return "Prompts";
  return "Resources";
}

const PaletteRowView = memo(function PaletteRowView({
  row,
  enabled,
  itemState,
  onReadResource,
}: {
  readonly row: PaletteItem;
  readonly enabled: boolean;
  readonly itemState: PaletteItemState;
  readonly onReadResource: McpPaletteProps["onReadResource"];
}) {
  const runState =
    row.kind === "resource"
      ? itemState[`${row.server.id}::resource::${row.resource?.uri ?? row.name}`]
      : undefined;
  const running = runState === "running";
  const error =
    runState && typeof runState === "object" && "error" in runState
      ? runState.error
      : undefined;

  // Resources stay click-to-read; tools and prompts have no per-item
  // action — their availability is governed entirely by the tag toggle
  // above. Clicks on those rows are no-ops, but we keep the row as a
  // button for keyboard parity with resources.
  const actionable = row.kind === "resource";

  const onActivate = () => {
    if (row.kind === "resource" && row.resource) {
      onReadResource(row.server, row.resource);
    }
  };

  return (
    <li className="mcp-palette-row-li">
      <div
        className="mcp-palette-row"
        data-kind={row.kind}
        data-enabled={enabled || undefined}
        data-error={error ? true : undefined}
        title={error ?? row.description}
      >
        <span className="mcp-palette-row-dot" aria-hidden />
        <code className="mcp-palette-row-name">{row.name}</code>
        <span className="mcp-palette-row-desc">{row.description}</span>
        <span className="mcp-palette-row-server" title={row.server.name}>
          {row.server.name}
        </span>
        {actionable ? (
          <button
            type="button"
            className="mcp-palette-row-action"
            onClick={onActivate}
            disabled={running}
          >
            {running ? "loading" : "open"}
          </button>
        ) : (
          <span className="mcp-palette-row-kind">{row.kind}</span>
        )}
      </div>
    </li>
  );
});

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
