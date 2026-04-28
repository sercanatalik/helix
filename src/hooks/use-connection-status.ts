import { useEffect, useState } from "react";
import { buildExtraBody, createClient } from "../lib/llm/client";
import type { ProviderConfig } from "../features/providers";

export type ConnectionStatus = "idle" | "checking" | "ok" | "fail";

export interface ConnectionInfo {
  readonly status: ConnectionStatus;
  readonly error?: string;
  readonly modelEcho?: string;
}

/** One-shot 1-token chat completion against the given provider. Re-runs
 * whenever the provider object changes (i.e. the user edits or switches the
 * active provider). Aborts on unmount or on a fast follow-up swap so we
 * don't apply stale results. */
export function useConnectionStatus(
  provider: ProviderConfig | undefined,
): ConnectionInfo {
  const [info, setInfo] = useState<ConnectionInfo>({ status: "idle" });

  useEffect(() => {
    if (!provider || !provider.baseUrl || !provider.model) {
      setInfo({ status: "idle" });
      return;
    }

    setInfo({ status: "checking" });
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const client = createClient(provider);
        const r = await client.chat.completions.create(
          {
            model: provider.model!,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
            stream: false,
            ...buildExtraBody(provider),
          },
          { signal: controller.signal },
        );
        if (cancelled) return;
        setInfo({ status: "ok", modelEcho: r.model });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setInfo({ status: "fail", error: message });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [provider]);

  return info;
}
