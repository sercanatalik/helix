import { useCallback, useMemo, useState } from "react";
import { Button } from "./ui";
import { KeyValueList } from "../features/providers/key-value-list";
import type { KeyValuePair } from "../features/providers";
import type {
  CustomHeader,
  McpServerConfig,
  McpServerInput,
  McpServerRuntime,
  McpTestResult,
  McpTransport,
} from "../app/types";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; result: McpTestResult }
  | { kind: "fail"; error: string; durationMs?: number };

interface McpFormProps {
  readonly title: string;
  /** When `id` is empty, the form is in "new server" mode and the parent
   * should call `add` on save; otherwise call `update`. */
  readonly initial: McpServerConfig;
  /** Optional runtime — surfaces tool/prompt/resource discovery + last error. */
  readonly runtime?: McpServerRuntime;
  readonly onCancel: () => void;
  readonly onSave: (input: McpServerInput) => void | Promise<void>;
  readonly onReconnect?: () => void | Promise<void>;
  readonly onDelete?: () => void | Promise<void>;
}

const TRANSPORTS: readonly McpTransport[] = ["http", "stdio"];

const TRANSPORT_LABELS: Readonly<Record<McpTransport, string>> = {
  http: "HTTP (remote)",
  stdio: "Stdio (local process)",
};

const STATUS_LABELS: Readonly<Record<McpServerRuntime["status"], string>> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disconnected",
  error: "Error",
};

function configToInput(config: McpServerConfig): McpServerInput {
  // Strip the id so the resulting object is suitable for `addMcpServer` and
  // matches the shape `updateMcpServer` accepts.
  const { id: _id, ...rest } = config;
  void _id;
  return rest;
}

function envToPairs(
  env: Readonly<Record<string, string>> | undefined,
): readonly KeyValuePair[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function pairsToEnv(
  pairs: readonly KeyValuePair[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (!k) continue;
    out[k] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function headersToPairs(
  headers: readonly CustomHeader[] | undefined,
): readonly KeyValuePair[] {
  if (!headers) return [];
  return headers.map((h) => ({ key: h.name, value: h.value }));
}

function pairsToHeaders(
  pairs: readonly KeyValuePair[],
): readonly CustomHeader[] | undefined {
  const out: CustomHeader[] = [];
  for (const { key, value } of pairs) {
    const name = key.trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out.length > 0 ? out : undefined;
}

function cleanInput(input: McpServerInput): McpServerInput {
  return {
    ...input,
    name: input.name.trim() || "Untitled MCP server",
    url: input.url?.trim() || undefined,
    command: input.command?.trim() || undefined,
    args: input.args && input.args.length > 0 ? input.args : undefined,
  };
}

export function McpForm({
  title,
  initial,
  runtime,
  onCancel,
  onSave,
  onReconnect,
  onDelete,
}: McpFormProps) {
  const [draft, setDraft] = useState<McpServerInput>(() =>
    configToInput(initial),
  );

  const setField = useCallback(
    <K extends keyof McpServerInput>(key: K, value: McpServerInput[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const onTransportChange = useCallback(
    (next: McpTransport) => {
      if (next === draft.transport) return;
      // Clear the inactive transport's fields so a save doesn't carry stale
      // URL/command state across the boundary.
      setDraft((d) => ({
        ...d,
        transport: next,
        url: next === "http" ? d.url ?? "" : undefined,
        command: next === "stdio" ? d.command ?? "" : undefined,
        args: next === "stdio" ? d.args ?? [] : undefined,
        env: next === "stdio" ? d.env : undefined,
        customHeaders: next === "http" ? d.customHeaders : undefined,
      }));
    },
    [draft.transport],
  );

  const canSave = useMemo(() => draft.name.trim().length > 0, [draft.name]);

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  /** Validate the draft can be tested before round-tripping to Rust — saves
   * a Tauri call for the obvious "you didn't fill in the URL yet" case. */
  const testReady = useMemo(() => {
    if (draft.transport === "http") {
      return (draft.url ?? "").trim().length > 0;
    }
    return (draft.command ?? "").trim().length > 0;
  }, [draft.transport, draft.url, draft.command]);

  const runTest = useCallback(async () => {
    if (!testReady) return;
    setTestState({ kind: "testing" });
    try {
      const result = await window.helixApi.testMcpServer(cleanInput(draft));
      if (result.ok) {
        setTestState({ kind: "ok", result });
      } else {
        setTestState({
          kind: "fail",
          error: result.error ?? "Connection failed.",
          durationMs: result.durationMs,
        });
      }
    } catch (err) {
      setTestState({
        kind: "fail",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [draft, testReady]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    void onSave(cleanInput(draft));
  };

  const argsJoined = useMemo(
    () => (draft.args ?? []).join(" "),
    [draft.args],
  );
  const envPairs = useMemo(() => envToPairs(draft.env), [draft.env]);
  const headerPairs = useMemo(
    () => headersToPairs(draft.customHeaders),
    [draft.customHeaders],
  );

  return (
    <form className="provider-form" onSubmit={submit}>
      <header className="provider-form-head">
        <button
          type="button"
          className="provider-back"
          onClick={onCancel}
          aria-label="Back to MCP servers"
        >
          ← Back
        </button>
        <h2 className="settings-section-title">{title}</h2>
        {runtime ? (
          <p className="settings-section-desc">
            Status: <strong>{STATUS_LABELS[runtime.status]}</strong>
            {runtime.error ? ` — ${runtime.error}` : null}
          </p>
        ) : null}
      </header>

      <FieldGroup legend="General">
        <Field
          label="Display name"
          hint="Shown in the MCP server list."
          input={
            <input
              className="field-input"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="My MCP server"
              required
            />
          }
        />
        <Field
          label="Enabled on launch"
          hint="When on, helix connects to this server automatically."
          input={
            <label className="mcp-switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setField("enabled", e.target.checked)}
              />
              <span>{draft.enabled ? "On" : "Off"}</span>
            </label>
          }
        />
      </FieldGroup>

      <FieldGroup
        legend="Transport"
        description="HTTP for remote endpoints; Stdio spawns a local process and speaks MCP over its pipes."
      >
        <div className="auth-mode-tabs" role="tablist">
          {TRANSPORTS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              className="auth-mode-tab"
              data-active={draft.transport === t || undefined}
              aria-selected={draft.transport === t}
              onClick={() => onTransportChange(t)}
            >
              {TRANSPORT_LABELS[t]}
            </button>
          ))}
        </div>

        {draft.transport === "http" ? (
          <Field
            label="URL"
            hint="e.g. http://localhost:8000/mcp"
            input={
              <input
                className="field-input mono"
                value={draft.url ?? ""}
                onChange={(e) => setField("url", e.target.value)}
                placeholder="http://localhost:8000/mcp"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
        ) : (
          <>
            <Field
              label="Command"
              hint="The executable to spawn (npx, uvx, …)."
              input={
                <input
                  className="field-input mono"
                  value={draft.command ?? ""}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder="npx"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              }
            />
            <Field
              label="Args"
              hint="Space-separated CLI arguments."
              input={
                <input
                  className="field-input mono"
                  value={argsJoined}
                  onChange={(e) =>
                    setField(
                      "args",
                      e.target.value.split(/\s+/).filter(Boolean),
                    )
                  }
                  placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              }
            />
          </>
        )}
      </FieldGroup>

      {draft.transport === "http" ? (
        <FieldGroup
          legend="Custom headers"
          description="Sent on every request to the MCP endpoint. Useful for bearer tokens or API keys."
        >
          <KeyValueList
            pairs={headerPairs}
            onChange={(pairs) =>
              setField("customHeaders", pairsToHeaders(pairs))
            }
            keyPlaceholder="X-Header-Name"
            valuePlaceholder="value"
            addLabel="Add header"
          />
        </FieldGroup>
      ) : (
        <FieldGroup
          legend="Environment variables"
          description="Set in the spawned process's environment."
        >
          <KeyValueList
            pairs={envPairs}
            onChange={(pairs) => setField("env", pairsToEnv(pairs))}
            keyPlaceholder="NAME"
            valuePlaceholder="value"
            addLabel="Add env var"
          />
        </FieldGroup>
      )}

      {runtime && runtime.status !== "disconnected" ? (
        <DiscoveryChips runtime={runtime} />
      ) : null}

      <div className="provider-test-row">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => void runTest()}
          disabled={!testReady || testState.kind === "testing"}
        >
          {testState.kind === "testing" ? "Testing…" : "Test connection"}
        </Button>
        <McpTestResultView state={testState} transport={draft.transport} />
      </div>

      <footer className="provider-form-actions">
        {onDelete ? (
          <Button variant="danger" size="lg" onClick={() => void onDelete()}>
            Delete server
          </Button>
        ) : null}
        <span className="actions-spacer" />
        {onReconnect ? (
          <Button
            variant="outline"
            size="lg"
            type="button"
            onClick={() => void onReconnect()}
          >
            Reconnect
          </Button>
        ) : null}
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={!canSave}>
          Save
        </Button>
      </footer>
    </form>
  );
}

function McpTestResultView({
  state,
  transport,
}: {
  readonly state: TestState;
  readonly transport: McpTransport;
}) {
  if (state.kind === "idle") {
    return (
      <span className="provider-test-hint">
        {transport === "http"
          ? "Opens a one-shot connection to the URL above and runs discovery."
          : "Spawns the command, runs the MCP handshake, and lists tools."}
      </span>
    );
  }
  if (state.kind === "testing") {
    return (
      <span className="provider-test-hint">
        Connecting and running discovery…
      </span>
    );
  }
  if (state.kind === "fail") {
    return (
      <div className="provider-test-result" data-state="fail">
        <div className="provider-test-result-message">{state.error}</div>
        {state.durationMs !== undefined ? (
          <div className="provider-test-result-meta">
            Failed after {state.durationMs} ms
          </div>
        ) : null}
      </div>
    );
  }
  // ok
  const r = state.result;
  const summary = [
    `${r.toolCount ?? 0} tools`,
    `${r.promptCount ?? 0} prompts`,
    `${r.resourceCount ?? 0} resources`,
  ].join(" · ");
  const partialErrors: string[] = [];
  if (r.toolsError) partialErrors.push(`tools/list: ${r.toolsError}`);
  if (r.promptsError) partialErrors.push(`prompts/list: ${r.promptsError}`);
  if (r.resourcesError)
    partialErrors.push(`resources/list: ${r.resourcesError}`);

  return (
    <div className="provider-test-result" data-state="ok">
      <div className="provider-test-result-head">
        Connected{r.durationMs !== undefined ? ` · ${r.durationMs} ms` : ""}
      </div>
      <div className="provider-test-result-message">{summary}</div>
      {partialErrors.length > 0 ? (
        <details className="provider-test-result-body" open>
          <summary>Partial discovery errors</summary>
          <pre>{partialErrors.join("\n")}</pre>
        </details>
      ) : null}
    </div>
  );
}

function FieldGroup({
  legend,
  description,
  children,
}: {
  readonly legend: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <fieldset className="field-group">
      <legend className="field-legend">{legend}</legend>
      {description ? <p className="field-group-desc">{description}</p> : null}
      <div className="field-group-body">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  input,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly input: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {input}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

type ChipKind = "tools" | "prompts" | "resources";

const CHIP_LABELS: Readonly<Record<ChipKind, string>> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
};

function DiscoveryChips({ runtime }: { readonly runtime: McpServerRuntime }) {
  const [open, setOpen] = useState<ChipKind | null>(null);

  const counts: Record<ChipKind, number> = {
    tools: runtime.tools.length,
    prompts: runtime.prompts.length,
    resources: runtime.resources.length,
  };

  // When the server is still connecting we leave chips inert — there's
  // nothing to show until the handshake completes.
  const interactive = runtime.status === "connected";

  const toggle = (kind: ChipKind) => {
    if (!interactive) return;
    setOpen((curr) => (curr === kind ? null : kind));
  };

  const errors: Record<ChipKind, string | undefined> = {
    tools: runtime.toolsError,
    prompts: runtime.promptsError,
    resources: runtime.resourcesError,
  };

  const renderItems = () => {
    if (open === null) return null;
    if (counts[open] === 0) {
      const err = errors[open];
      if (err) {
        return (
          <div className="mcp-discovery-empty mcp-discovery-empty-error">
            <strong>{CHIP_LABELS[open]}/list</strong> failed: {err}
            <span className="mcp-discovery-empty-hint">
              The connection is open, but this discovery call returned an
              error. Most often this means the server doesn't implement that
              capability — try Reconnect, or check the server's logs.
            </span>
          </div>
        );
      }
      return (
        <p className="mcp-discovery-empty">
          Server didn't advertise any {CHIP_LABELS[open]}. The connection
          succeeded, but the server reported no {CHIP_LABELS[open]} in its
          capabilities.
        </p>
      );
    }
    if (open === "tools") {
      return (
        <ul className="mcp-discovery-list">
          {runtime.tools.map((tool) => (
            <li key={tool.name} className="mcp-discovery-item">
              <code className="mcp-discovery-name">{tool.name}</code>
              {tool.description ? (
                <span className="mcp-discovery-desc">
                  {" "}
                  — {tool.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    if (open === "prompts") {
      return (
        <ul className="mcp-discovery-list">
          {runtime.prompts.map((prompt) => (
            <li key={prompt.name} className="mcp-discovery-item">
              <code className="mcp-discovery-name">{prompt.name}</code>
              {prompt.description ? (
                <span className="mcp-discovery-desc">
                  {" "}
                  — {prompt.description}
                </span>
              ) : null}
              {prompt.arguments && prompt.arguments.length > 0 ? (
                <span className="mcp-discovery-meta">
                  {" "}
                  ({prompt.arguments.map((a) => a.name).join(", ")})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ul className="mcp-discovery-list">
        {runtime.resources.map((resource) => (
          <li key={resource.uri} className="mcp-discovery-item">
            <code className="mcp-discovery-name">{resource.uri}</code>
            {resource.name ? (
              <span className="mcp-discovery-desc">
                {" "}
                — {resource.name}
              </span>
            ) : null}
            {resource.mimeType ? (
              <span className="mcp-discovery-meta">
                {" "}
                [{resource.mimeType}]
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="mcp-chips-wrap">
      <div className="mcp-chips-row" role="tablist">
        <DiscoveryChip
          kind="tools"
          label="Tools"
          count={counts.tools}
          active={open === "tools"}
          interactive={interactive}
          onClick={() => toggle("tools")}
        />
        <DiscoveryChip
          kind="prompts"
          label="Prompts"
          count={counts.prompts}
          active={open === "prompts"}
          interactive={interactive}
          onClick={() => toggle("prompts")}
        />
        <DiscoveryChip
          kind="resources"
          label="Resources"
          count={counts.resources}
          active={open === "resources"}
          interactive={interactive}
          onClick={() => toggle("resources")}
        />
      </div>
      {renderItems()}
    </div>
  );
}

function DiscoveryChip({
  kind,
  label,
  count,
  active,
  interactive,
  onClick,
}: {
  readonly kind: ChipKind;
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly interactive: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-pressed={active}
      aria-disabled={!interactive}
      className="mcp-chip"
      data-active={active || undefined}
      data-disabled={!interactive || undefined}
      data-empty={count === 0 || undefined}
      onClick={onClick}
    >
      <ChipIcon kind={kind} />
      <span className="mcp-chip-label">{label}</span>
      <span className="mcp-chip-count">{count}</span>
      <ChevronIcon />
    </button>
  );
}

function ChipIcon({ kind }: { readonly kind: ChipKind }) {
  switch (kind) {
    case "tools":
      // Wrench
      return (
        <svg
          aria-hidden
          className="mcp-chip-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a4 4 0 0 1 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4z" />
          <path d="M14.7 6.3 18 3l3 3-3.3 3.3" />
        </svg>
      );
    case "prompts":
      // Sparkle
      return (
        <svg
          aria-hidden
          className="mcp-chip-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
        </svg>
      );
    case "resources":
      // Document
      return (
        <svg
          aria-hidden
          className="mcp-chip-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h4" />
        </svg>
      );
  }
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden
      className="mcp-chip-chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
