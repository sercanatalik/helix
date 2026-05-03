/* helix-ai · corporate proxy config.
 *
 * Captures a single HTTP/HTTPS forward proxy with optional Basic auth.
 * Persisted to localStorage in the same shape the future internet-search
 * client (and any other outbound HTTP surface that needs to honour it)
 * will read. The renderer's browser-fetch can't be configured to route
 * through a proxy, so anything that needs to actually use this should go
 * through the Tauri `@tauri-apps/plugin-http` bridge — that's where the
 * proxy field on a per-request options object actually lands.
 */

export interface ProxyConfig {
  /** Master switch. When false the rest of the fields are remembered but
   * ignored — same shape Settings → Providers uses for inactive entries. */
  readonly enabled: boolean;
  /** Hostname or IP. No scheme — `host` and `port` combine into the
   * `http://host:port` URL the HTTP client expects. */
  readonly host: string;
  readonly port: number;
  /** Optional Basic-auth username. Empty string == "no auth". Stored
   * alongside the password verbatim; this is intended for corporate
   * proxies and we don't pretend to encrypt at rest. */
  readonly username: string;
  readonly password: string;
}

const KEY = "helix.proxy.v1";

export function emptyProxyConfig(): ProxyConfig {
  return { enabled: false, host: "", port: 8080, username: "", password: "" };
}

export function loadProxyConfig(): ProxyConfig {
  if (typeof window === "undefined") return emptyProxyConfig();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyProxyConfig();
    const parsed = JSON.parse(raw) as Partial<ProxyConfig>;
    return {
      enabled: !!parsed.enabled,
      host: typeof parsed.host === "string" ? parsed.host : "",
      port: typeof parsed.port === "number" ? parsed.port : 8080,
      username: typeof parsed.username === "string" ? parsed.username : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
    };
  } catch {
    return emptyProxyConfig();
  }
}

export function saveProxyConfig(config: ProxyConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // Quota / privacy mode — best-effort, mirrors providers/storage.ts.
  }
}

/** Resolve a config to the URL form HTTP clients accept (`http://user:pass@host:port`).
 * Returns `undefined` when the config is disabled or has no host so callers
 * can short-circuit without checking flags themselves. The credentials are
 * URL-encoded so usernames containing `@` or passwords containing `:` don't
 * corrupt the string. */
export function proxyConfigToUrl(config: ProxyConfig): string | undefined {
  if (!config.enabled || !config.host) return undefined;
  const auth =
    config.username.length > 0
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : "";
  return `http://${auth}${config.host}:${config.port}`;
}
