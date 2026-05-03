import { useCallback, useEffect, useState } from "react";
import {
  emptyProxyConfig,
  loadProxyConfig,
  saveProxyConfig,
  type ProxyConfig,
} from "../lib/proxy";

export interface UseProxyResult {
  readonly config: ProxyConfig;
  readonly setConfig: (next: ProxyConfig) => void;
  readonly patch: (patch: Partial<ProxyConfig>) => void;
  readonly reset: () => void;
}

/** Single source of truth for the corporate-proxy config. Hydrates from
 * localStorage on mount and persists on every change. */
export function useProxy(): UseProxyResult {
  const [config, setConfigState] = useState<ProxyConfig>(() =>
    loadProxyConfig(),
  );

  useEffect(() => {
    saveProxyConfig(config);
  }, [config]);

  const setConfig = useCallback((next: ProxyConfig) => {
    setConfigState(next);
  }, []);

  const patch = useCallback((patch: Partial<ProxyConfig>) => {
    setConfigState((curr) => ({ ...curr, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setConfigState(emptyProxyConfig());
  }, []);

  return { config, setConfig, patch, reset };
}
