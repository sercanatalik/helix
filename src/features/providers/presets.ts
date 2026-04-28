/* helix-ai · built-in provider presets.
 *
 * Each preset seeds a ProviderConfig with sensible defaults. The user can
 * always override base URL, model, auth mode, headers, and body params.
 * To add a provider, append a new entry — the UI picks them up automatically.
 */

import type { ProviderAuth, ProviderPreset } from "./types";

const bearer = (apiKey = ""): ProviderAuth => ({
  mode: "api_key_header",
  headerName: "Authorization",
  valueTemplate: "Bearer {key}",
  apiKey,
});

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-4o, o-series, and friends. Chat completions API.",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    defaultAuth: bearer(),
  },
  {
    id: "litellm",
    name: "LiteLLM",
    description:
      "Self-hosted proxy that fronts 100+ LLMs behind one OpenAI-compatible API.",
    baseUrl: "http://localhost:4000",
    defaultModel: "gpt-4o-mini",
    defaultAuth: bearer(),
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude 4.x family. Messages API.",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    defaultAuth: {
      mode: "api_key_header",
      headerName: "x-api-key",
      valueTemplate: "{key}",
      apiKey: "",
    },
  },
  {
    id: "groq",
    name: "Groq",
    description: "Low-latency hosted inference for open models.",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.1-70b-versatile",
    defaultAuth: bearer(),
  },
  {
    id: "mistral",
    name: "Mistral",
    description: "Mistral and Mixtral models from Mistral AI.",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    defaultAuth: bearer(),
  },
  {
    id: "together",
    name: "Together AI",
    description: "Hosted open-source models behind an OpenAI-compatible API.",
    baseUrl: "https://api.together.xyz/v1",
    defaultAuth: bearer(),
  },
  {
    id: "cohere",
    name: "Cohere",
    description: "Command R / R+ and embedding models.",
    baseUrl: "https://api.cohere.com/v1",
    defaultAuth: bearer(),
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "Run local models via the Ollama daemon.",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    defaultAuth: { mode: "none" },
  },
  {
    id: "openai-compat",
    name: "OpenAI-compatible",
    description:
      "Any service exposing an OpenAI-shaped API. Set base URL, model, and auth.",
    baseUrl: "",
    defaultAuth: bearer(),
  },
  {
    id: "custom",
    name: "Custom",
    description: "Fully custom endpoint — pick the auth mode by hand.",
    baseUrl: "",
    defaultAuth: { mode: "none" },
  },
] as const;

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
