import { useMemo } from "react";
import {
  contextWindowFor,
  estimateMessageTokens,
  estimateTokens,
} from "../../../lib/llm/context-window";
import type { TranscriptMessage } from "../../../app/types";
import type { PendingContextEntry } from "./pending-context";

interface ContextUsageChipProps {
  readonly messages: readonly TranscriptMessage[];
  readonly pendingContext: readonly PendingContextEntry[];
  readonly modelId: string | undefined;
  readonly contextResetAt: string | undefined;
  readonly onReset?: () => void;
}

/** Estimate-and-show chip: how full the model's context window is right now,
 * based on the visible transcript plus any prompt/resource context the user
 * has cued up. Estimation is approximate (chars/4 + small per-message
 * overhead) — exact tokenization would mean shipping a tokenizer per provider.
 * Hidden until there's something to show; turns amber over 70%, red over 90%.
 *
 * Clicking the chip resets the model-side context — older messages stay
 * visible in the transcript but stop being sent to the model, dropping the
 * percentage back to 0 and freeing the window for fresh turns. */
export function ContextUsageChip({
  messages,
  pendingContext,
  modelId,
  contextResetAt,
  onReset,
}: ContextUsageChipProps) {
  const { used, window } = useMemo(() => {
    const window = contextWindowFor(modelId);
    const sendable = contextResetAt
      ? messages.filter((m) => m.createdAt >= contextResetAt)
      : messages;
    let used = estimateMessageTokens(sendable);
    for (const ctx of pendingContext) used += estimateTokens(ctx.content);
    return { used, window };
  }, [messages, pendingContext, modelId, contextResetAt]);

  if (used <= 0) return null;
  const pct = Math.min(100, Math.round((used / window) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const title = onReset
    ? `${formatTokens(used)} / ${formatTokens(window)} tokens (estimate) — click to reset context`
    : `${formatTokens(used)} / ${formatTokens(window)} tokens (estimate)`;

  if (!onReset) {
    return (
      <span className="context-chip" data-tone={tone} title={title}>
        <span className="context-chip-bar" aria-hidden>
          <span className="context-chip-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="context-chip-pct">{pct}%</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="context-chip context-chip-reset"
      data-tone={tone}
      title={title}
      aria-label={`Reset context (${pct}% used)`}
      onClick={onReset}
    >
      <span className="context-chip-bar" aria-hidden>
        <span className="context-chip-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="context-chip-pct">{pct}%</span>
    </button>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
