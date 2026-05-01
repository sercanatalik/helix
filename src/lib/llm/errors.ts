/* helix-ai · LLM error type.
 *
 * Single error shape the rest of the app pattern-matches on. Replaces the
 * OpenAI SDK's APIError + APIConnectionError split so call sites only need
 * one `instanceof` check. Connection failures land here too, with `status`
 * left undefined and the original fetch error in `cause`. */

export interface LLMErrorOptions {
  readonly message: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string;
  readonly type?: string;
  readonly body?: unknown;
  readonly url?: string;
  readonly cause?: unknown;
}

export class LLMError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly code?: string;
  readonly type?: string;
  readonly body?: unknown;
  readonly url?: string;

  constructor(opts: LLMErrorOptions) {
    super(opts.message);
    this.name = "LLMError";
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.code = opts.code;
    this.type = opts.type;
    this.body = opts.body;
    this.url = opts.url;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}
