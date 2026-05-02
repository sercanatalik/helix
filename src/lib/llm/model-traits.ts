/* helix-ai · model-id heuristics shared between chat and provider-form.
 *
 * These are pattern-match against the model id so we don't have to maintain
 * an exhaustive list — every reasoning family follows one of these prefixes
 * and OpenAI-compatible proxies (LiteLLM, OpenRouter, …) forward the id
 * verbatim. */

/** Models that reject `max_tokens` and require `max_completion_tokens`.
 * Anthropic's "thinking" mode doesn't apply here — those models still take
 * `max_tokens`. */
const REASONING_MODEL_RE = /(?:^|\/)(?:o[134](?:-|$)|gpt-5(?:$|[-:]))/i;

export function isReasoningModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return REASONING_MODEL_RE.test(modelId);
}
