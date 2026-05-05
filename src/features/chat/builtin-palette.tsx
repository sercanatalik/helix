import { memo, useEffect, useMemo, useRef, useState } from "react";
import { estimateTokens } from "../../lib/llm/context-window";
import {
  BUILTIN_GROUP_LABEL,
  type BuiltinToolDef,
  type BuiltinToolGroup,
} from "../../lib/builtin-tools";

export interface BuiltinPaletteProps {
  readonly tools: readonly BuiltinToolDef[];
  readonly isEnabled: (name: string) => boolean;
  readonly onToggle: (name: string, enabled: boolean) => void;
  readonly onClose: () => void;
  readonly popoverRef?: React.Ref<HTMLDivElement>;
}

/** Helix Core (built-in) toolbox, structured to match the MCP palette so
 * the two popovers feel like the same surface. Built-in tools have no
 * advertised tags — we use their `group` field (`file_system`, `data`) as
 * the top-level grouping, with the same tag-pill / iOS-switch / cost-footer
 * shell. Toggles are group-level only: clicking the switch on a group
 * bulk-enables (or bulk-disables) every tool inside it, mirroring the
 * MCP palette's "user opts into capabilities, not individual functions"
 * stance. The underlying per-tool storage in `useBuiltinTools` keeps
 * working — we just don't expose per-tool affordances any more. */
export function BuiltinPalette({
  tools,
  isEnabled,
  onToggle,
  onClose,
  popoverRef,
}: BuiltinPaletteProps) {
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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

  const groups = useMemo(() => groupByGroup(tools), [tools]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((g) => filter === "all" || g.group === filter)
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (t) =>
            !q ||
            t.label.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, filter, query]);

  const cost = useMemo(() => {
    let enabled = 0;
    let off = 0;
    let tokens = 0;
    for (const t of tools) {
      const live = isEnabled(t.name);
      if (live) {
        enabled++;
        tokens +=
          estimateTokens(t.description) +
          estimateTokens(JSON.stringify(t.inputSchema));
      } else {
        off++;
      }
    }
    return { enabled, off, tokens };
  }, [tools, isEnabled]);

  return (
    <div
      ref={popoverRef}
      className="mcp-palette"
      role="dialog"
      aria-label="Helix Core tools"
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
          placeholder="Search Helix Core tools…"
          aria-label="Search Helix Core tools"
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
        {groups.map(({ group }) => (
          <button
            key={group}
            type="button"
            role="tab"
            className="mcp-palette-filter"
            data-tag
            data-active={filter === group || undefined}
            aria-selected={filter === group}
            onClick={() => setFilter(group)}
          >
            #{group}
          </button>
        ))}
        <span className="mcp-palette-filters-spacer" />
        <span className="mcp-palette-filters-meta">helix core</span>
      </div>

      <div className="mcp-palette-body">
        {visibleGroups.length === 0 ? (
          <p className="mcp-palette-empty">No matches.</p>
        ) : (
          visibleGroups.map((g) => (
            <BuiltinGroup
              key={g.group}
              group={g.group}
              label={BUILTIN_GROUP_LABEL[g.group]}
              items={g.items}
              isEnabled={isEnabled}
              onToggle={onToggle}
            />
          ))
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
          <kbd>↵</kbd> toggle group{" "}
          <span className="mcp-palette-footer-sep">·</span> <kbd>⌘.</kbd> close
        </span>
      </div>
    </div>
  );
}

interface GroupBucket {
  readonly group: BuiltinToolGroup;
  readonly items: readonly BuiltinToolDef[];
}

function groupByGroup(
  tools: readonly BuiltinToolDef[],
): readonly GroupBucket[] {
  const map = new Map<BuiltinToolGroup, BuiltinToolDef[]>();
  for (const t of tools) {
    let bucket = map.get(t.group);
    if (!bucket) {
      bucket = [];
      map.set(t.group, bucket);
    }
    bucket.push(t);
  }
  return Array.from(map.entries()).map(([group, items]) => ({
    group,
    items,
  }));
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function BuiltinGroup({
  group,
  label,
  items,
  isEnabled,
  onToggle,
}: {
  readonly group: BuiltinToolGroup;
  readonly label: string;
  readonly items: readonly BuiltinToolDef[];
  readonly isEnabled: (name: string) => boolean;
  readonly onToggle: (name: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const enabledCount = items.filter((t) => isEnabled(t.name)).length;
  // Mirror the MCP palette's "any-tag-on counts as on" stance — a group
  // reads as enabled if at least one of its tools is enabled. Toggling
  // the switch then either fans the new state across every tool (so a
  // mixed-on state collapses cleanly to all-on or all-off) or leaves
  // them all off.
  const allOn = enabledCount === items.length;
  const someOn = enabledCount > 0;
  const onToggleAll = () => {
    const next = !someOn;
    for (const t of items) {
      if (isEnabled(t.name) === next) continue;
      onToggle(t.name, next);
    }
  };

  return (
    <section className="mcp-palette-group">
      <header className="mcp-palette-group-head">
        <button
          type="button"
          className="mcp-palette-group-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse group" : "Expand group"}
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
          data-active={someOn || undefined}
          onClick={onToggleAll}
          aria-pressed={someOn}
          title={someOn ? `Disable ${label}` : `Enable ${label}`}
        >
          #{group}
        </button>
        <span className="mcp-palette-group-meta">
          {items.length} {items.length === 1 ? "tool" : "tools"}
        </span>
        <span
          className="mcp-palette-group-marker"
          data-state={someOn ? "on" : "off"}
        >
          {allOn ? "on" : someOn ? "mixed" : "off"}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={someOn}
          aria-label={`Toggle ${label}`}
          className="mcp-switch-pill"
          data-on={someOn || undefined}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleAll();
          }}
        >
          <span className="mcp-switch-thumb" aria-hidden />
        </button>
      </header>
      {open ? (
        <div className="mcp-palette-rows">
          <div className="mcp-palette-kind">
            <div className="mcp-palette-kind-head" data-kind="tool">
              <span className="mcp-palette-kind-dot" aria-hidden />
              <span className="mcp-palette-kind-label">{label}</span>
              <span className="mcp-palette-kind-count">· {items.length}</span>
            </div>
            <ul className="mcp-palette-row-list" role="list">
              {items.map((t) => (
                <BuiltinRow key={t.name} tool={t} enabled={isEnabled(t.name)} />
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const BuiltinRow = memo(function BuiltinRow({
  tool,
  enabled,
}: {
  readonly tool: BuiltinToolDef;
  readonly enabled: boolean;
}) {
  return (
    <li className="mcp-palette-row-li">
      <div
        className="mcp-palette-row"
        data-kind="tool"
        data-enabled={enabled || undefined}
        title={tool.description}
      >
        <span className="mcp-palette-row-dot" aria-hidden />
        <code className="mcp-palette-row-name">{tool.label}</code>
        <span className="mcp-palette-row-desc">{tool.description}</span>
        <span className="mcp-palette-row-server">helix-core</span>
        <span className="mcp-palette-row-kind">tool</span>
      </div>
    </li>
  );
});
