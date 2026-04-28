/* helix-ai · provider type contract.
 *
 * A ProviderConfig fully describes how to call an LLM HTTP endpoint:
 * base URL, model, auth mode, and optional extra headers / body params.
 * Auth is a discriminated union so the consumer (HTTP client, etc.) can
 * branch cleanly per mode without ad-hoc null checks.
 */

export type ProviderId = string;

export type AuthMode = "none" | "api_key_header" | "api_key_body" | "basic";

export interface NoneAuth {
  readonly mode: "none";
}

/** API key sent as an HTTP header. valueTemplate uses `{key}` as the
 * placeholder so callers can model both `Bearer {key}` and bare `{key}`. */
export interface ApiKeyHeaderAuth {
  readonly mode: "api_key_header";
  readonly headerName: string;
  readonly valueTemplate: string;
  readonly apiKey: string;
}

/** API key sent inside the JSON request body under a configurable key. */
export interface ApiKeyBodyAuth {
  readonly mode: "api_key_body";
  readonly bodyKey: string;
  readonly apiKey: string;
}

export interface BasicAuth {
  readonly mode: "basic";
  readonly username: string;
  readonly password: string;
}

export type ProviderAuth =
  | NoneAuth
  | ApiKeyHeaderAuth
  | ApiKeyBodyAuth
  | BasicAuth;

export interface ProviderConfig {
  readonly id: ProviderId;
  /** id of the preset this was created from; "custom" if hand-rolled. */
  readonly presetId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly auth: ProviderAuth;
  readonly extraHeaders: readonly KeyValuePair[];
  /** extra_params merged into the JSON request body. Optional feature. */
  readonly extraParams: readonly KeyValuePair[];
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface KeyValuePair {
  readonly key: string;
  readonly value: string;
}

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  readonly defaultAuth: ProviderAuth;
}

export const AUTH_MODE_LABELS: Readonly<Record<AuthMode, string>> = {
  none: "No auth",
  api_key_header: "API key (header)",
  api_key_body: "API key (body)",
  basic: "Basic auth",
};
