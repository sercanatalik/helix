/* helix-ai · context-window estimation.
 *
 * Tokenizers are model-specific and we don't ship one — pulling tiktoken or
 * @anthropic-ai/tokenizer would balloon the bundle for an indicator the user
 * mostly glances at. Instead we use the standard `chars / 4` rule of thumb,
 * which gets within ±15% of the real BPE count for English prose and fenced
 * code. Good enough to drive the "X% used" pill in the composer.
 *
 * The window-by-model table is patterns-first: the model id is matched against
 * a few known prefixes/keywords. Unknowns fall back to a 128K default — the
 * modal context window across modern hosted models. Misses err on the side of
 * "you have more headroom than the bar suggests" rather than a false alarm. */

import type { ChatMessage } from "./types";

export const DEFAULT_CONTEXT_WINDOW = 128_000;

interface WindowRule {
  readonly match: RegExp;
  readonly window: number;
}

/** Order matters: more-specific patterns must precede general ones. */
const RULES: readonly WindowRule[] = [
  // Anthropic — Claude 3.x / 3.5 / 4.x default to 200K. The 1M-context
  // variants advertise their size in the model id.
  { match: /1m/i, window: 1_000_000 },
  { match: /claude/i, window: 200_000 },

  // OpenAI
  { match: /gpt-4o|gpt-4-turbo|gpt-4\.1|gpt-5/i, window: 128_000 },
  { match: /o1|o3|o4/i, window: 200_000 },
  { match: /gpt-4-32k/i, window: 32_768 },
  { match: /gpt-4(?!o)/i, window: 8_192 },
  { match: /gpt-3\.5-turbo-16k/i, window: 16_385 },
  { match: /gpt-3\.5/i, window: 16_385 },

  // Google
  { match: /gemini.*pro.*1\.5|gemini-1\.5-pro|gemini-2/i, window: 1_000_000 },
  { match: /gemini.*flash.*1\.5|gemini-1\.5-flash/i, window: 1_000_000 },
  { match: /gemini/i, window: 32_768 },

  // Mistral
  { match: /mistral-large|mistral-small|mistral-medium/i, window: 128_000 },
  { match: /mixtral/i, window: 32_768 },

  // Meta
  { match: /llama-?3\.[12]/i, window: 128_000 },
  { match: /llama-?3/i, window: 8_192 },
  { match: /llama-?2/i, window: 4_096 },

  // DeepSeek, Qwen
  { match: /deepseek-(v3|coder|chat)/i, window: 64_000 },
  { match: /qwen2?\.5/i, window: 128_000 },
  { match: /qwen/i, window: 32_768 },

  // Cohere Command R+
  { match: /command-r/i, window: 128_000 },
];

export function contextWindowFor(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  for (const rule of RULES) {
    if (rule.match.test(modelId)) return rule.window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** ~chars/4 — the standard "tokens per English character" approximation. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

interface MessageLike {
  readonly role: string;
  readonly content: string;
}

/** Estimate tokens across an array of messages. Counts a small fixed overhead
 * per message for the role wrapping the BPE tokenizer adds (`<|im_start|>` etc).
 * 4 tokens per message is what OpenAI's `num_tokens_from_messages` uses. */
export function estimateMessageTokens(
  messages: readonly MessageLike[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total + 2; // priming tokens
}

/** Count tokens for a list of full ChatMessage objects, walking string +
 * tool-call payloads. Used when a caller already has the API-side stack;
 * when it only has user-visible transcript text, prefer estimateMessageTokens. */
export function estimateChatTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role === "tool") {
      total += estimateTokens(m.content);
    } else if (m.role === "assistant") {
      if (m.content) total += estimateTokens(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += estimateTokens(tc.function.name);
          total += estimateTokens(tc.function.arguments);
        }
      }
    } else {
      total += estimateTokens(m.content);
    }
    total += 4;
  }
  return total + 2;
}
