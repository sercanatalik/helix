import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadActiveProviderId,
  loadProviders,
  newProviderId,
  saveActiveProviderId,
  saveProviders,
} from "./storage";
import type { ProviderConfig, ProviderId } from "./types";

export interface UseProvidersResult {
  readonly providers: readonly ProviderConfig[];
  /** The id explicitly chosen as active. Undefined when nothing is pinned. */
  readonly activeId: ProviderId | undefined;
  /** The provider to actually use right now: the active one if it's enabled,
   * otherwise the first enabled provider. Undefined when none is usable. */
  readonly activeProvider: ProviderConfig | undefined;
  readonly upsert: (config: ProviderConfig) => void;
  readonly remove: (id: ProviderId) => void;
  readonly toggleEnabled: (id: ProviderId) => void;
  readonly setActive: (id: ProviderId | undefined) => void;
  readonly newId: () => string;
}

export function useProviders(): UseProvidersResult {
  const [providers, setProviders] = useState<readonly ProviderConfig[]>(() =>
    loadProviders(),
  );
  const [activeId, setActiveId] = useState<ProviderId | undefined>(() =>
    loadActiveProviderId(),
  );

  useEffect(() => {
    saveProviders(providers);
  }, [providers]);

  useEffect(() => {
    saveActiveProviderId(activeId);
  }, [activeId]);

  // Resolution rule: the explicit active wins when it points to an enabled
  // provider; otherwise fall back to the first enabled one. This is what
  // "connect to the latest provider on launch" means in practice — the most
  // recently saved provider becomes active automatically (see upsert below),
  // and we keep using it across restarts.
  const activeProvider = useMemo<ProviderConfig | undefined>(() => {
    if (activeId) {
      const pinned = providers.find((p) => p.id === activeId && p.enabled);
      if (pinned) return pinned;
    }
    return providers.find((p) => p.enabled);
  }, [providers, activeId]);

  const upsert = useCallback((config: ProviderConfig) => {
    setProviders((curr) => {
      const idx = curr.findIndex((p) => p.id === config.id);
      if (idx === -1) return [...curr, config];
      const next = curr.slice();
      next[idx] = config;
      return next;
    });
    // Saving a provider implies "use this one". Mirrors gcf-desktop's
    // behaviour where the most recently touched provider becomes active.
    setActiveId(config.id);
  }, []);

  const remove = useCallback((id: ProviderId) => {
    setProviders((curr) => curr.filter((p) => p.id !== id));
    setActiveId((curr) => (curr === id ? undefined : curr));
  }, []);

  const toggleEnabled = useCallback((id: ProviderId) => {
    setProviders((curr) =>
      curr.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p)),
    );
  }, []);

  const setActive = useCallback((id: ProviderId | undefined) => {
    setActiveId(id);
  }, []);

  return {
    providers,
    activeId,
    activeProvider,
    upsert,
    remove,
    toggleEnabled,
    setActive,
    newId: newProviderId,
  };
}
