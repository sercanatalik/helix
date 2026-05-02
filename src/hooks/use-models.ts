import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "../lib/llm/client";
import type { ProviderConfig } from "../features/providers";

/** Result of attempting to discover models for a provider. We always offer at
 * least the provider's configured default so the model switcher is never
 * empty — when `/models` errors, we fall back to that single entry. */
export interface UseModelsResult {
  /** Discovered model ids, plus the provider default if it isn't already in
   * the list. Empty only when the provider has no default and the endpoint
   * call failed. */
  readonly models: readonly string[];
  readonly isLoading: boolean;
  /** Set when the models endpoint failed. UI shows this as a quiet hint
   * rather than a hard error — the default model still works. */
  readonly error: string | null;
  /** True when `models` was populated from `/models` rather than synthesised
   * from `provider.model`. Used to label the "default only" fallback. */
  readonly fromEndpoint: boolean;
  /** Force a re-fetch — used by the "refresh" button in the model picker. */
  readonly refresh: () => void;
}

/** Cache by `${providerId}::${baseUrl}` so swapping back to a provider whose
 * `/models` we already fetched is instant. The base URL is part of the key
 * because the user can edit it without changing the id. */
const modelCache = new Map<
  string,
  { readonly models: readonly string[]; readonly fromEndpoint: boolean }
>();

function cacheKey(p: ProviderConfig): string {
  return `${p.id}::${p.baseUrl}`;
}

export function useModels(provider: ProviderConfig | undefined): UseModelsResult {
  const [models, setModels] = useState<readonly string[]>(() =>
    provider ? modelCache.get(cacheKey(provider))?.models ?? [] : [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromEndpoint, setFromEndpoint] = useState<boolean>(() =>
    provider ? modelCache.get(cacheKey(provider))?.fromEndpoint ?? false : false,
  );
  const [refreshTick, setRefreshTick] = useState(0);
  // Track the latest in-flight provider so a slow response from a stale
  // provider can't clobber state after the user switched.
  const liveKeyRef = useRef<string | null>(null);

  const defaultModel = provider?.model;

  useEffect(() => {
    if (!provider) {
      setModels([]);
      setFromEndpoint(false);
      setError(null);
      return;
    }
    const key = cacheKey(provider);
    liveKeyRef.current = key;

    const cached = modelCache.get(key);
    if (cached && refreshTick === 0) {
      setModels(mergeDefault(cached.models, defaultModel));
      setFromEndpoint(cached.fromEndpoint);
      setError(null);
      return;
    }

    const ac = new AbortController();
    setIsLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createClient(provider);
        const list = await client.listModels({ signal: ac.signal });
        if (liveKeyRef.current !== key) return;
        const merged = mergeDefault(list, defaultModel);
        modelCache.set(key, { models: list, fromEndpoint: true });
        setModels(merged);
        setFromEndpoint(true);
      } catch (err) {
        if (ac.signal.aborted) return;
        if (liveKeyRef.current !== key) return;
        const fallback = defaultModel ? [defaultModel] : [];
        modelCache.set(key, { models: fallback, fromEndpoint: false });
        setModels(fallback);
        setFromEndpoint(false);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (liveKeyRef.current === key) setIsLoading(false);
      }
    })();
    return () => ac.abort();
  }, [provider?.id, provider?.baseUrl, defaultModel, refreshTick]);

  const refresh = useMemo(
    () => () => {
      if (provider) modelCache.delete(cacheKey(provider));
      setRefreshTick((t) => t + 1);
    },
    [provider?.id, provider?.baseUrl],
  );

  return { models, isLoading, error, fromEndpoint, refresh };
}

/** Make sure the provider's default model is reachable in the list — handy
 * when /models returns a curated subset that omits the configured default
 * (e.g. a deprecated model the user is still pinning). */
function mergeDefault(
  list: readonly string[],
  defaultModel: string | undefined,
): readonly string[] {
  if (!defaultModel) return list;
  if (list.includes(defaultModel)) return list;
  return [defaultModel, ...list];
}
