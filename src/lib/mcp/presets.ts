/* helix-ai · built-in MCP server presets.
 *
 * Each preset is a one-click starter — picking it pre-fills the new-server
 * form with sensible defaults. The user can edit any field before saving.
 * To add a preset, append to PRESETS — the UI picks it up automatically.
 */

import type { McpServerInput } from "../../app/types";

export interface McpServerPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Returns a fresh McpServerInput. The preset never mutates a shared
   * object, so callers can safely treat the returned value as their draft. */
  build(): McpServerInput;
}

export const MCP_SERVER_PRESETS: readonly McpServerPreset[] = [
  {
    id: "localhost-helix",
    name: "Local helix MCP",
    description:
      "Connects to a local MCP server at http://localhost:8000/mcp. Enabled by default — start the server before opening helix.",
    build: () => ({
      name: "Local helix MCP",
      enabled: true,
      transport: "http",
      url: "http://localhost:8000/mcp",
    }),
  },
  {
    id: "http",
    name: "HTTP (remote)",
    description:
      "Any MCP server reachable over HTTP / streamable-HTTP. Add headers if the endpoint requires auth.",
    build: () => ({
      name: "Remote MCP server",
      enabled: false,
      transport: "http",
      url: "",
    }),
  },
  {
    id: "stdio",
    name: "Stdio (local process)",
    description:
      "Spawns a command and speaks MCP over its stdin/stdout. Use for npm / uvx-published servers.",
    build: () => ({
      name: "Stdio MCP server",
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: [],
    }),
  },
] as const;

export function findMcpServerPreset(id: string): McpServerPreset | undefined {
  return MCP_SERVER_PRESETS.find((p) => p.id === id);
}
