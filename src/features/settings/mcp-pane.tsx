import { useMemo, useState } from "react";
import { useMcpServers } from "../../hooks/use-mcp-servers";
import {
  MCP_SERVER_PRESETS,
  type McpServerPreset,
} from "../../lib/mcp/presets";
import { Badge, Button } from "../../components/ui";
import { cardSurface } from "../../components/ui/card";
import { cn } from "../../lib/utils";
import { McpForm } from "./mcp-form";
import type {
  McpConnectionStatus,
  McpServerConfig,
  McpServerInput,
} from "../../app/types";

type Mode =
  | { kind: "list" }
  | { kind: "edit"; draft: McpServerConfig; isNew: boolean };

const STATUS_LABELS: Readonly<Record<McpConnectionStatus, string>> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disabled",
  error: "Error",
};

const STATUS_BADGE: Readonly<
  Record<McpConnectionStatus, "default" | "outline" | "muted">
> = {
  connected: "default",
  connecting: "muted",
  disconnected: "outline",
  error: "outline",
};

/** Make a placeholder McpServerConfig for the form's "new" mode. The id is a
 * sentinel — the parent only persists with `add`, never `update`, when isNew
 * is true. */
function draftFromPreset(preset: McpServerPreset): McpServerConfig {
  const input = preset.build();
  return {
    id: "__new__",
    ...input,
  };
}

export function McpPane() {
  const { servers, runtime, add, update, remove, reconnect } = useMcpServers();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const sorted = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  );

  if (mode.kind === "edit") {
    const isNew = mode.isNew;
    const liveRuntime = isNew ? undefined : runtime[mode.draft.id];
    return (
      <McpForm
        title={
          isNew
            ? `New MCP server${
                mode.draft.name ? ` — ${mode.draft.name}` : ""
              }`
            : `Edit ${mode.draft.name}`
        }
        initial={mode.draft}
        runtime={liveRuntime}
        onCancel={() => setMode({ kind: "list" })}
        onSave={async (input) => {
          if (isNew) {
            await add(input);
          } else {
            await update(mode.draft.id, input);
          }
          setMode({ kind: "list" });
        }}
        onReconnect={
          isNew
            ? undefined
            : async () => {
                await reconnect(mode.draft.id);
              }
        }
        onDelete={
          isNew
            ? undefined
            : async () => {
                await remove(mode.draft.id);
                setMode({ kind: "list" });
              }
        }
      />
    );
  }

  return (
    <section className="providers-pane">
      <h2 className="settings-section-title">MCP servers</h2>
      <p className="settings-section-desc">
        Configure Model Context Protocol servers helix connects to. Enabled
        servers connect on launch; their tools, prompts, and resources become
        available to the agent. Pick a preset below or add a custom endpoint.
      </p>

      <div className="providers-section-label">Configured</div>
      {sorted.length === 0 ? (
        <p className="providers-empty">
          No MCP servers configured yet. Pick a preset below to get started.
        </p>
      ) : (
        <ul className="providers-list">
          {sorted.map((server) => {
            const liveRuntime = runtime[server.id];
            const status: McpConnectionStatus =
              liveRuntime?.status ?? "disconnected";
            return (
              <li
                key={server.id}
                className="provider-row"
                data-disabled={!server.enabled || undefined}
              >
                <button
                  type="button"
                  className="provider-row-main"
                  onClick={() =>
                    setMode({ kind: "edit", draft: server, isNew: false })
                  }
                >
                  <div className="provider-row-head">
                    <span className="provider-row-name">
                      {server.name || "(unnamed)"}
                    </span>
                    <Badge variant={STATUS_BADGE[status]}>
                      {STATUS_LABELS[status]}
                    </Badge>
                  </div>
                  <div className="provider-row-meta">
                    <span className="provider-row-url">
                      {transportSummary(server) || (
                        <em>not configured</em>
                      )}
                    </span>
                    {liveRuntime && liveRuntime.status === "connected" ? (
                      <>
                        <span className="provider-row-sep">·</span>
                        <span className="provider-row-model">
                          {liveRuntime.tools.length} tools
                        </span>
                      </>
                    ) : null}
                    {liveRuntime?.error ? (
                      <>
                        <span className="provider-row-sep">·</span>
                        <span className="provider-row-model" title={liveRuntime.error}>
                          {liveRuntime.error.length > 60
                            ? `${liveRuntime.error.slice(0, 60)}…`
                            : liveRuntime.error}
                        </span>
                      </>
                    ) : null}
                  </div>
                </button>
                <div className="provider-row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void update(server.id, { enabled: !server.enabled })
                    }
                    aria-pressed={server.enabled}
                  >
                    {server.enabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="providers-section-label">Add server</div>
      <ul className="preset-grid">
        {MCP_SERVER_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              onClick={() =>
                setMode({
                  kind: "edit",
                  draft: draftFromPreset(preset),
                  isNew: true,
                })
              }
              className={cn(
                cardSurface,
                "w-full px-3 py-2.5 flex flex-col gap-1 text-left transition-colors hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)]",
              )}
            >
              <span className="text-[12.5px] font-semibold text-[var(--fg)]">
                {preset.name}
              </span>
              <span className="text-[11px] text-[var(--fg-dim)] leading-[1.4]">
                {preset.description}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One-line summary of where the server points — URL for HTTP, command + args
 * for stdio. Returns an empty string when the user hasn't filled anything in
 * yet, so the row can render a `<em>not configured</em>` fallback. */
function transportSummary(server: McpServerConfig): string {
  if (server.transport === "http") {
    return server.url ?? "";
  }
  const cmd = server.command ?? "";
  const args = (server.args ?? []).join(" ");
  return [cmd, args].filter(Boolean).join(" ").trim();
}
