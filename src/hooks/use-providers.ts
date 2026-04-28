import { useCallback, useEffect, useState } from "react";
import {
  loadProviders,
  newProviderId,
  saveProviders,
} from "../providers/storage";
import type { ProviderConfig, ProviderId } from "../providers/types";

export interface UseProvidersResult {
  readonly providers: readonly ProviderConfig[];
  readonly upsert: (config: ProviderConfig) => void;
  readonly remove: (id: ProviderId) => void;
  readonly toggleEnabled: (id: ProviderId) => void;
  readonly newId: () => string;
}

export function useProviders(): UseProvidersResult {
  const [providers, setProviders] = useState<readonly ProviderConfig[]>(() =>
    loadProviders(),
  );

  useEffect(() => {
    saveProviders(providers);
  }, [providers]);

  const upsert = useCallback((config: ProviderConfig) => {
    setProviders((curr) => {
      const idx = curr.findIndex((p) => p.id === config.id);
      if (idx === -1) return [...curr, config];
      const next = curr.slice();
      next[idx] = config;
      return next;
    });
  }, []);

  const remove = useCallback((id: ProviderId) => {
    setProviders((curr) => curr.filter((p) => p.id !== id));
  }, []);

  const toggleEnabled = useCallback((id: ProviderId) => {
    setProviders((curr) =>
      curr.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    );
  }, []);

  return { providers, upsert, remove, toggleEnabled, newId: newProviderId };
}
