import { useCallback, useEffect, useState } from "react";
import type {
  DesktopAppState,
  McpServerConfig,
  McpServerInput,
  McpServerRuntime,
} from "../app/types";

const EMPTY_SERVERS: readonly McpServerConfig[] = [];
const EMPTY_RUNTIME: Readonly<Record<string, McpServerRuntime>> = {};

export interface UseMcpServersResult {
  readonly servers: readonly McpServerConfig[];
  /** Connection state per server, keyed by server id. Missing entries mean
   * the manager hasn't reported on that server yet (treat as disconnected). */
  readonly runtime: Readonly<Record<string, McpServerRuntime>>;
  readonly add: (input: McpServerInput) => Promise<void>;
  readonly update: (
    id: string,
    patch: Partial<McpServerInput>,
  ) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly reconnect: (id: string) => Promise<void>;
  readonly setToolEnabled: (
    serverId: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;
}

/** Read-write view over the MCP server list owned by the Rust backend.
 *
 * The hook seeds itself with `getState()`, then keeps in sync via the
 * `helix://state-changed` push channel that fires every time `McpManager`
 * transitions a server (connecting → connected, error, disconnected). All
 * mutators delegate to `window.helixApi`; the Rust side is the source of
 * truth, so we don't keep a local optimistic copy. */
export function useMcpServers(): UseMcpServersResult {
  const [servers, setServers] =
    useState<readonly McpServerConfig[]>(EMPTY_SERVERS);
  const [runtime, setRuntime] =
    useState<Readonly<Record<string, McpServerRuntime>>>(EMPTY_RUNTIME);

  // Seed once on mount.
  useEffect(() => {
    let cancelled = false;
    void window.helixApi
      .getState()
      .then((state) => {
        if (cancelled) return;
        setServers(state.mcpServers);
        setRuntime(state.mcpRuntime);
      })
      .catch(() => {
        // Backend not ready yet — keep empty defaults.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to push updates. The listener fires on connect/disconnect
  // transitions; cheap to leave attached for the lifetime of the pane.
  useEffect(() => {
    const apply = (state: DesktopAppState) => {
      setServers(state.mcpServers);
      setRuntime(state.mcpRuntime);
    };
    return window.helixApi.onStateChanged(apply);
  }, []);

  const add = useCallback(async (input: McpServerInput) => {
    const state = await window.helixApi.addMcpServer(input);
    setServers(state.mcpServers);
    setRuntime(state.mcpRuntime);
  }, []);

  const update = useCallback(
    async (id: string, patch: Partial<McpServerInput>) => {
      const state = await window.helixApi.updateMcpServer(id, patch);
      setServers(state.mcpServers);
      setRuntime(state.mcpRuntime);
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    const state = await window.helixApi.removeMcpServer(id);
    setServers(state.mcpServers);
    setRuntime(state.mcpRuntime);
  }, []);

  const reconnect = useCallback(async (id: string) => {
    const state = await window.helixApi.reconnectMcpServer(id);
    setServers(state.mcpServers);
    setRuntime(state.mcpRuntime);
  }, []);

  const setToolEnabled = useCallback(
    async (serverId: string, toolName: string, enabled: boolean) => {
      const state = await window.helixApi.setMcpToolEnabled(
        serverId,
        toolName,
        enabled,
      );
      setServers(state.mcpServers);
      setRuntime(state.mcpRuntime);
    },
    [],
  );

  return { servers, runtime, add, update, remove, reconnect, setToolEnabled };
}
