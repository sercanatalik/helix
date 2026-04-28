import { useCallback, useMemo, useState } from "react";
import { APIError } from "openai";
import { KeyValueList } from "./key-value-list";
import { Button } from "../../components/ui";
import { buildExtraBody, createClient } from "../../lib/llm/client";
import {
  AUTH_MODE_LABELS,
  type AuthMode,
  type ProviderAuth,
  type ProviderConfig,
} from "./types";

interface TestFailure {
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string;
  readonly type?: string;
  readonly message: string;
  /** Endpoint we attempted to reach — most useful info for connection errors. */
  readonly requestUrl?: string;
  /** Raw response body or serialized error cause, when one is available. */
  readonly body?: unknown;
}

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; modelEcho?: string }
  | ({ kind: "fail" } & TestFailure);

function extractFailure(err: unknown, requestUrl?: string): TestFailure {
  if (err instanceof APIError) {
    const body = (err as { error?: unknown }).error;
    const inner = isRecord(body) ? body : undefined;
    const cause = (err as { cause?: unknown }).cause;
    // For APIConnectionError there's no parsed response body — the only
    // useful detail is the wrapped fetch error sitting in `cause`.
    const detail = body !== undefined && body !== null ? body : cause;
    return {
      status: err.status,
      code: typeof err.code === "string" ? err.code : undefined,
      type: typeof err.type === "string" ? err.type : pickString(inner, "type"),
      message: pickString(inner, "message") ?? err.message,
      body: describeError(detail),
      requestUrl,
    };
  }
  if (err instanceof Error) {
    return {
      message: err.message,
      body: describeError(err.cause),
      requestUrl,
    };
  }
  return { message: String(err), requestUrl };
}

/** Walk Error → plain-object so JSON.stringify produces something readable.
 * Error instances have non-enumerable `name`/`message` and otherwise stringify
 * to `{}`, which is why "Connection error" used to show up bare. */
function describeError(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    const e = value as Error & { code?: unknown };
    const out: Record<string, unknown> = {
      name: e.name,
      message: e.message,
    };
    if (typeof e.code === "string") out.code = e.code;
    if (e.cause !== undefined && e.cause !== e) {
      const inner = describeError(e.cause);
      if (inner !== undefined) out.cause = inner;
    }
    return out;
  }
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function cleanDraft(draft: ProviderConfig): ProviderConfig {
  const clean = (xs: readonly { key: string; value: string }[]) =>
    xs.filter((p) => p.key.trim() !== "");
  return {
    ...draft,
    name: draft.name.trim() || draft.name,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model?.trim() || undefined,
    extraHeaders: clean(draft.extraHeaders),
    extraParams: clean(draft.extraParams),
  };
}

interface ProviderFormProps {
  readonly initial: ProviderConfig;
  readonly title: string;
  readonly onCancel: () => void;
  readonly onSave: (config: ProviderConfig) => void;
  readonly onDelete?: () => void;
}

const AUTH_MODES: readonly AuthMode[] = [
  "none",
  "api_key_header",
  "api_key_body",
  "basic",
];

/** Returns a sane default ProviderAuth for the given mode without losing
 * any field state the user has already entered for that mode. */
function defaultAuthFor(mode: AuthMode): ProviderAuth {
  switch (mode) {
    case "none":
      return { mode: "none" };
    case "api_key_header":
      return {
        mode: "api_key_header",
        headerName: "Authorization",
        valueTemplate: "Bearer {key}",
        apiKey: "",
      };
    case "api_key_body":
      return { mode: "api_key_body", bodyKey: "api_key", apiKey: "" };
    case "basic":
      return { mode: "basic", username: "", password: "" };
  }
}

export function ProviderForm({
  initial,
  title,
  onCancel,
  onSave,
  onDelete,
}: ProviderFormProps) {
  const [draft, setDraft] = useState<ProviderConfig>(initial);

  const setField = useCallback(<K extends keyof ProviderConfig>(
    key: K,
    value: ProviderConfig[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  const setAuth = useCallback((auth: ProviderAuth) => {
    setDraft((d) => ({ ...d, auth }));
  }, []);

  const onModeChange = (mode: AuthMode) => {
    if (mode === draft.auth.mode) return;
    setAuth(defaultAuthFor(mode));
  };

  const canSave = useMemo(() => draft.name.trim().length > 0, [draft.name]);

  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const isTesting = testState.kind === "testing";

  const testConnection = useCallback(async () => {
    const cleaned = cleanDraft(draft);
    if (!cleaned.baseUrl) {
      setTestState({ kind: "fail", message: "Set a base URL first." });
      return;
    }
    if (!cleaned.model) {
      setTestState({
        kind: "fail",
        message: "Set a default model to test against.",
      });
      return;
    }
    setTestState({ kind: "testing" });
    try {
      const client = createClient(cleaned);
      const r = await client.chat.completions.create({
        model: cleaned.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
        ...buildExtraBody(cleaned),
      });
      setTestState({ kind: "ok", modelEcho: r.model });
    } catch (err) {
      setTestState({
        kind: "fail",
        ...extractFailure(err, cleaned.baseUrl),
      });
    }
  }, [draft]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    onSave(cleanDraft({ ...draft, name: draft.name.trim() }));
  };

  return (
    <form className="provider-form" onSubmit={submit}>
      <header className="provider-form-head">
        <button
          type="button"
          className="provider-back"
          onClick={onCancel}
          aria-label="Back to providers"
        >
          ← Back
        </button>
        <h2 className="settings-section-title">{title}</h2>
      </header>

      <FieldGroup legend="General">
        <Field
          label="Display name"
          hint="Shown in the provider list."
          input={
            <input
              className="field-input"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="My OpenAI"
              required
            />
          }
        />
        <Field
          label="Base URL"
          hint="HTTP endpoint root. e.g. https://api.openai.com/v1"
          input={
            <input
              className="field-input mono"
              value={draft.baseUrl}
              onChange={(e) => setField("baseUrl", e.target.value)}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          }
        />
        <Field
          label="Default model"
          hint="Optional. Used when a session doesn't specify one."
          input={
            <input
              className="field-input mono"
              value={draft.model ?? ""}
              onChange={(e) => setField("model", e.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          }
        />
      </FieldGroup>

      <FieldGroup
        legend="Authentication"
        description="How requests to this provider are authenticated."
      >
        <div className="auth-mode-tabs" role="tablist">
          {AUTH_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              className="auth-mode-tab"
              data-active={draft.auth.mode === mode || undefined}
              aria-selected={draft.auth.mode === mode}
              onClick={() => onModeChange(mode)}
            >
              {AUTH_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <AuthFields auth={draft.auth} onChange={setAuth} />
      </FieldGroup>

      <FieldGroup
        legend="Extra request headers"
        description="Optional. Sent on every request to this provider."
      >
        <KeyValueList
          pairs={draft.extraHeaders}
          onChange={(pairs) => setField("extraHeaders", pairs)}
          keyPlaceholder="X-Custom-Header"
          valuePlaceholder="value"
          addLabel="Add header"
        />
      </FieldGroup>

      <FieldGroup
        legend="Extra body params"
        description="Optional. Merged into the JSON request body as extra_params."
      >
        <KeyValueList
          pairs={draft.extraParams}
          onChange={(pairs) => setField("extraParams", pairs)}
          keyPlaceholder="param_name"
          valuePlaceholder="value"
          addLabel="Add param"
        />
      </FieldGroup>

      <div className="provider-test-row">
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => void testConnection()}
          disabled={isTesting}
        >
          {isTesting ? "Testing…" : "Test connection"}
        </Button>
        {testState.kind === "ok" ? (
          <span className="provider-test-result" data-state="ok">
            Connected
            {testState.modelEcho ? ` · ${testState.modelEcho}` : null}
          </span>
        ) : testState.kind === "fail" ? (
          <TestFailureDetail failure={testState} />
        ) : (
          <span className="provider-test-hint">
            Sends a 1-token chat completion to verify base URL, auth, and model.
          </span>
        )}
      </div>

      <footer className="provider-form-actions">
        {onDelete ? (
          <Button variant="danger" size="lg" onClick={onDelete}>
            Delete provider
          </Button>
        ) : null}
        <span className="actions-spacer" />
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

function AuthFields({
  auth,
  onChange,
}: {
  readonly auth: ProviderAuth;
  readonly onChange: (auth: ProviderAuth) => void;
}) {
  switch (auth.mode) {
    case "none":
      return (
        <p className="field-note">
          No authentication is added. Requests are sent as-is.
        </p>
      );
    case "api_key_header":
      return (
        <>
          <Field
            label="Header name"
            input={
              <input
                className="field-input mono"
                value={auth.headerName}
                onChange={(e) =>
                  onChange({ ...auth, headerName: e.target.value })
                }
                placeholder="Authorization"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
          <Field
            label="Value template"
            hint="Use {key} as the placeholder for the API key."
            input={
              <input
                className="field-input mono"
                value={auth.valueTemplate}
                onChange={(e) =>
                  onChange({ ...auth, valueTemplate: e.target.value })
                }
                placeholder="Bearer {key}"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
          <Field
            label="API key"
            input={
              <input
                className="field-input mono"
                type="password"
                value={auth.apiKey}
                onChange={(e) => onChange({ ...auth, apiKey: e.target.value })}
                placeholder="sk-…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
        </>
      );
    case "api_key_body":
      return (
        <>
          <Field
            label="Body key"
            hint="JSON field name the API key is sent under."
            input={
              <input
                className="field-input mono"
                value={auth.bodyKey}
                onChange={(e) => onChange({ ...auth, bodyKey: e.target.value })}
                placeholder="api_key"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
          <Field
            label="API key"
            input={
              <input
                className="field-input mono"
                type="password"
                value={auth.apiKey}
                onChange={(e) => onChange({ ...auth, apiKey: e.target.value })}
                placeholder="sk-…"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
        </>
      );
    case "basic":
      return (
        <>
          <Field
            label="Username"
            input={
              <input
                className="field-input"
                value={auth.username}
                onChange={(e) =>
                  onChange({ ...auth, username: e.target.value })
                }
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            }
          />
          <Field
            label="Password"
            input={
              <input
                className="field-input"
                type="password"
                value={auth.password}
                onChange={(e) =>
                  onChange({ ...auth, password: e.target.value })
                }
              />
            }
          />
        </>
      );
  }
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

function TestFailureDetail({ failure }: { readonly failure: TestFailure }) {
  const headBits: string[] = [];
  if (failure.status !== undefined) headBits.push(String(failure.status));
  if (failure.code) headBits.push(failure.code);
  if (failure.type && failure.type !== failure.code) headBits.push(failure.type);
  const head = headBits.join(" · ");

  const bodyJson =
    failure.body !== undefined ? safeStringify(failure.body) : null;

  // Connection-style errors land here with no status/code/body — give them a
  // contextual hint so the user has something actionable beyond the message.
  const isConnectionError = !head && !bodyJson && /connection|fetch|network/i.test(failure.message);

  return (
    <div className="provider-test-result" data-state="fail">
      {head ? <div className="provider-test-result-head">{head}</div> : null}
      <div className="provider-test-result-message">{failure.message}</div>
      {failure.requestUrl ? (
        <div className="provider-test-result-meta">
          → {failure.requestUrl}
        </div>
      ) : null}
      {isConnectionError ? (
        <div className="provider-test-result-hint">
          The request never reached a server. Likely causes: wrong base URL,
          provider unreachable, or the API doesn't allow browser CORS.
        </div>
      ) : null}
      {bodyJson ? (
        <details className="provider-test-result-body" open>
          <summary>Details</summary>
          <pre>{bodyJson}</pre>
        </details>
      ) : null}
    </div>
  );
}

function safeStringify(value: unknown): string | null {
  try {
    const out = JSON.stringify(value, null, 2);
    return out && out !== "{}" && out !== "null" ? out : null;
  } catch {
    return null;
  }
}
