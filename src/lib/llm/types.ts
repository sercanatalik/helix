/* helix-ai · LLM wire-format types.
 *
 * Mirrors the OpenAI-compatible Chat Completions schema we send and receive
 * over HTTP. Kept deliberately narrow — only the fields the rest of the app
 * actually reads. Anthropic, Mistral, Groq, LiteLLM, Ollama, etc. all expose
 * this shape on `/chat/completions`, so we don't pull in any vendor SDK. */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly ChatToolCall[];
    }
  | {
      readonly role: "tool";
      readonly tool_call_id: string;
      readonly content: string;
    };

export interface ChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
}

export type ToolChoice = "auto" | "none" | "required";

/** Body of `POST /chat/completions`. Indexer permits provider-specific extras
 * (extra_params, api_key_body) without forcing every caller to widen its type. */
export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[];
  tool_choice?: ToolChoice;
  max_tokens?: number;
  stream?: boolean;
  [extra: string]: unknown;
}

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: {
    readonly role: "assistant";
    readonly content: string | null;
    readonly tool_calls?: readonly ChatToolCall[];
  };
  readonly finish_reason: string | null;
}

export interface ChatCompletion {
  readonly id?: string;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
}

/** Streaming delta — fields that arrive piecemeal across SSE chunks. Tool
 * calls are sliced by `index` so the consumer can stitch name/arguments back
 * together as fragments arrive. */
export interface ChatCompletionChunkDelta {
  readonly role?: ChatRole;
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<{
    readonly index?: number;
    readonly id?: string;
    readonly type?: "function";
    readonly function?: {
      readonly name?: string;
      readonly arguments?: string;
    };
  }>;
}

export interface ChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: ChatCompletionChunkDelta;
  readonly finish_reason: string | null;
}

export interface ChatCompletionChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices: readonly ChatCompletionChunkChoice[];
}
