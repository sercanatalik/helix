import OpenAI from "openai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { ProviderConfig } from "../../features/providers";

// Tauri's fetch routes through the Rust HTTP client (reqwest), bypassing the
// WebView's CORS policy and surfacing real network errors instead of
// WKWebView's opaque "Load failed". When running in a non-Tauri context
// (vite dev with no native shell), fall back to globalThis.fetch.
const httpFetch: typeof globalThis.fetch =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? (tauriFetch as typeof globalThis.fetch)
    : globalThis.fetch.bind(globalThis);

// Translate ProviderConfig.auth into the headers the OpenAI SDK should send
// on every request. The SDK's own `apiKey` only emits `Authorization: Bearer`,
// which doesn't fit providers like Anthropic (`x-api-key: {key}`) — so we
// always compose the auth header ourselves and pass a placeholder apiKey.
function buildHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { key, value } of provider.extraHeaders) {
    if (key.trim()) headers[key] = value;
  }
  const { auth } = provider;
  switch (auth.mode) {
    case "none":
      break;
    case "api_key_header":
      headers[auth.headerName] = auth.valueTemplate.replace(
        "{key}",
        auth.apiKey,
      );
      break;
    case "basic":
      headers.Authorization = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
      break;
    case "api_key_body":
      // Body-injected auth must be merged into the request body by the
      // caller; nothing to set as a header here.
      break;
  }
  return headers;
}

export function createClient(provider: ProviderConfig): OpenAI {
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: "placeholder",
    dangerouslyAllowBrowser: true,
    defaultHeaders: buildHeaders(provider),
    fetch: httpFetch,
  });
}

/** Body fields a caller must merge into the chat completion request to honour
 * `extra_params` and `api_key_body`-style auth. */
export function buildExtraBody(
  provider: ProviderConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const { key, value } of provider.extraParams) {
    if (key.trim()) body[key] = value;
  }
  if (provider.auth.mode === "api_key_body") {
    body[provider.auth.bodyKey] = provider.auth.apiKey;
  }
  return body;
}
