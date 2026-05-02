/* helix-ai · LLM HTTP client.
 *
 * A tiny client for OpenAI-compatible `/chat/completions` endpoints. We don't
 * pull in any vendor SDK — everything any of our supported providers (OpenAI,
 * Anthropic via Messages-compatible proxies, LiteLLM, Groq, Mistral, Together,
 * Cohere, Ollama) actually needs is a JSON POST that may stream back as SSE.
 *
 * The Tauri HTTP plugin routes through the Rust reqwest stack, which bypasses
 * the WebView's CORS policy and surfaces real network errors instead of
 * WKWebView's opaque "Load failed". When running in a non-Tauri context
 * (vite dev with no native shell), we fall back to globalThis.fetch. */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { ProviderConfig } from "../../features/providers";
import { LLMError } from "./errors";
import { parseSSEStream } from "./stream";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
} from "./types";

const httpFetch: typeof globalThis.fetch =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? (tauriFetch as typeof globalThis.fetch)
    : globalThis.fetch.bind(globalThis);

/** Translate ProviderConfig.auth into the headers each request should send.
 * The OpenAI SDK could only emit `Authorization: Bearer`; doing this ourselves
 * lets providers like Anthropic use `x-api-key: {key}` straightforwardly. */
function buildHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
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
      // Body-injected auth is merged by buildExtraBody; no header to set.
      break;
  }
  return headers;
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

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface LLMClient {
  /** One-shot completion. Throws LLMError on transport or HTTP failure. */
  chat(
    request: ChatCompletionRequest,
    opts?: RequestOptions,
  ): Promise<ChatCompletion>;
  /** Streaming completion. Returns an async iterable of SSE chunks; the
   * iterator finishes when the provider sends `data: [DONE]` or closes. */
  chatStream(
    request: ChatCompletionRequest,
    opts?: RequestOptions,
  ): AsyncIterable<ChatCompletionChunk>;
  /** List available models from the provider's `/models` endpoint. Returns
   * model ids in the order the provider reported them. Throws LLMError on
   * transport or HTTP failure — callers fall back to `provider.model`. */
  listModels(opts?: RequestOptions): Promise<readonly string[]>;
}

export function createClient(provider: ProviderConfig): LLMClient {
  const url = joinUrl(provider.baseUrl, "/chat/completions");
  const modelsUrl = joinUrl(provider.baseUrl, "/models");
  const baseHeaders = buildHeaders(provider);

  return {
    async chat(request, opts) {
      const response = await sendRequest(url, baseHeaders, request, false, opts);
      try {
        return (await response.json()) as ChatCompletion;
      } catch (err) {
        throw new LLMError({
          message: `Could not parse response JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          url,
          cause: err,
        });
      }
    },

    chatStream(request, opts) {
      // Defer the request until the consumer starts iterating so the AbortSignal
      // semantics line up with for-await usage in callers.
      return streamCompletions(url, baseHeaders, request, opts);
    },

    async listModels(opts) {
      return fetchModels(modelsUrl, baseHeaders, opts);
    },
  };
}

/** GET the provider's `/models` endpoint and tease out model ids from the
 * grab-bag of shapes providers actually return:
 *   - OpenAI / OpenRouter / LiteLLM:  `{ data: [{ id }] }`
 *   - Ollama:                         `{ models: [{ name }] }`
 *   - bare array:                     `[{ id }]` or `["model-a", ...]`
 * Anything we can't recognise becomes an empty list (caller falls back). */
async function fetchModels(
  url: string,
  baseHeaders: Record<string, string>,
  opts?: RequestOptions,
): Promise<readonly string[]> {
  const headers: Record<string, string> = {
    ...baseHeaders,
    Accept: "application/json",
  };
  // Drop the JSON Content-Type — GET has no body, and some servers reject it.
  delete headers["Content-Type"];

  let response: Response;
  try {
    response = await httpFetch(url, {
      method: "GET",
      headers,
      signal: opts?.signal,
    });
  } catch (err) {
    if (opts?.signal?.aborted) throw err;
    throw new LLMError({
      message: `Connection error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      url,
      cause: err,
    });
  }
  if (!response.ok) {
    throw await buildHttpError(response, url);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new LLMError({
      message: `Could not parse models response JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      url,
      cause: err,
    });
  }
  return extractModelIds(payload);
}

function extractModelIds(payload: unknown): readonly string[] {
  const out: string[] = [];
  const push = (entry: unknown) => {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry);
      return;
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const id = e.id ?? e.name ?? e.model;
      if (typeof id === "string" && id.trim()) out.push(id);
    }
  };
  if (Array.isArray(payload)) {
    for (const entry of payload) push(entry);
  } else if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const list = Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(obj.models)
        ? obj.models
        : null;
    if (list) for (const entry of list) push(entry);
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

async function sendRequest(
  url: string,
  baseHeaders: Record<string, string>,
  request: ChatCompletionRequest,
  stream: boolean,
  opts?: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = { ...baseHeaders };
  headers.Accept = stream ? "text/event-stream" : "application/json";
  const body = JSON.stringify({ ...request, stream });

  let response: Response;
  try {
    response = await httpFetch(url, {
      method: "POST",
      headers,
      body,
      signal: opts?.signal,
    });
  } catch (err) {
    if (opts?.signal?.aborted) {
      throw err;
    }
    throw new LLMError({
      message: `Connection error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      url,
      cause: err,
    });
  }

  if (!response.ok) {
    throw await buildHttpError(response, url);
  }
  return response;
}

async function buildHttpError(response: Response, url: string): Promise<LLMError> {
  const text = await response.text().catch(() => "");
  let parsed: unknown = text || undefined;
  let detailMessage: string | undefined;
  let code: string | undefined;
  let type: string | undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
      const errObj = (parsed as { error?: unknown }).error;
      if (errObj && typeof errObj === "object") {
        const e = errObj as Record<string, unknown>;
        if (typeof e.message === "string") detailMessage = e.message;
        if (typeof e.code === "string") code = e.code;
        if (typeof e.type === "string") type = e.type;
      } else if (typeof (parsed as { message?: unknown }).message === "string") {
        detailMessage = (parsed as { message: string }).message;
      }
    } catch {
      // Body wasn't JSON — keep the raw text on .body.
    }
  }
  const fallback =
    `HTTP ${response.status}` +
    (response.statusText ? ` ${response.statusText}` : "");
  return new LLMError({
    message: detailMessage || fallback,
    status: response.status,
    statusText: response.statusText,
    code,
    type,
    body: parsed,
    url,
  });
}

async function* streamCompletions(
  url: string,
  baseHeaders: Record<string, string>,
  request: ChatCompletionRequest,
  opts?: RequestOptions,
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const response = await sendRequest(url, baseHeaders, request, true, opts);
  if (!response.body) {
    throw new LLMError({
      message: "Streaming response has no readable body.",
      url,
    });
  }
  yield* parseSSEStream(response.body);
}
