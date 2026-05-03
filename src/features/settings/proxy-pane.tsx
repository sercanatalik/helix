import { type ReactNode } from "react";
import { Button } from "../../components/ui";
import { useProxy } from "../../hooks/use-proxy";

/** Settings → Proxy pane.
 *
 * Captures a corporate forward proxy + optional HTTP Basic auth. The form
 * writes through to localStorage on every keystroke (same pattern as the
 * provider config); a future internet-search client and any other
 * outbound HTTP surface should read `useProxy()` to honour this. */
export function ProxyPane() {
  const { config, patch, reset } = useProxy();

  return (
    <section>
      <h2 className="settings-section-title">Proxy</h2>
      <p className="settings-section-desc">
        Route outbound HTTP (internet search, model downloads) through a
        corporate forward proxy. Disable to fall back to the system
        defaults.
      </p>

      <FieldGroup
        legend="Proxy server"
        description="Host and port of the upstream proxy. The renderer combines them into http://host:port at request time."
      >
        <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span className="field-label" style={{ margin: 0 }}>
            Enable proxy
          </span>
        </label>
        <Field
          label="Host"
          hint="Hostname or IP. No scheme — e.g. proxy.corp.example."
          input={
            <input
              className="field-input mono"
              value={config.host}
              onChange={(e) => patch({ host: e.target.value.trim() })}
              placeholder="proxy.corp.example"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={!config.enabled}
            />
          }
        />
        <Field
          label="Port"
          hint="Default 8080."
          input={
            <input
              className="field-input mono"
              type="number"
              min={1}
              max={65535}
              value={config.port}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                patch({ port: Number.isFinite(n) ? n : 0 });
              }}
              placeholder="8080"
              disabled={!config.enabled}
            />
          }
        />
      </FieldGroup>

      <FieldGroup
        legend="Authentication"
        description="HTTP Basic auth. Leave blank when the proxy is unauthenticated."
      >
        <Field
          label="Username"
          input={
            <input
              className="field-input"
              value={config.username}
              onChange={(e) => patch({ username: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              disabled={!config.enabled}
            />
          }
        />
        <Field
          label="Password"
          hint="Stored in localStorage in plaintext — this is for corporate proxies, not a secret-management replacement."
          input={
            <input
              className="field-input"
              type="password"
              value={config.password}
              onChange={(e) => patch({ password: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              disabled={!config.enabled}
            />
          }
        />
      </FieldGroup>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button variant="ghost" onClick={reset}>
          Clear
        </Button>
      </div>
    </section>
  );
}

function FieldGroup({
  legend,
  description,
  children,
}: {
  readonly legend: string;
  readonly description?: string;
  readonly children: ReactNode;
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
  readonly input: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {input}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
