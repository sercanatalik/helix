import { useCallback, useMemo, useState } from "react";
import { KeyValueList } from "./key-value-list";
import {
  AUTH_MODE_LABELS,
  type AuthMode,
  type ProviderAuth,
  type ProviderConfig,
} from "../providers/types";

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    // Strip empty key/value rows to keep the persisted config tidy.
    const clean = (xs: readonly { key: string; value: string }[]) =>
      xs.filter((p) => p.key.trim() !== "");
    onSave({
      ...draft,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model?.trim() || undefined,
      extraHeaders: clean(draft.extraHeaders),
      extraParams: clean(draft.extraParams),
    });
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

      <footer className="provider-form-actions">
        {onDelete ? (
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            onClick={onDelete}
          >
            Delete provider
          </button>
        ) : null}
        <span className="actions-spacer" />
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          Save
        </button>
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
