import { useState, type ComponentType } from "react";
import { ProvidersPane } from "../providers";
import { McpPane } from "../../components/mcp-pane";
import { AppearancePane } from "./appearance";
import { GeneralPane } from "./general";

interface SettingsPane {
  readonly id: string;
  readonly label: string;
  readonly Component: ComponentType;
}

// Registry of settings panes. New features (skills, …) register their own
// pane here without touching the settings shell.
const PANES: readonly SettingsPane[] = [
  { id: "appearance", label: "Appearance", Component: AppearancePane },
  { id: "providers", label: "Providers", Component: ProvidersPane },
  { id: "mcp", label: "MCP", Component: McpPane },
  { id: "general", label: "General", Component: GeneralPane },
];

export function Settings() {
  const [activeId, setActiveId] = useState<string>(PANES[0]!.id);
  const ActiveComponent =
    PANES.find((p) => p.id === activeId)?.Component ?? PANES[0]!.Component;

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {PANES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="settings-nav-item"
            data-active={activeId === id}
            onClick={() => setActiveId(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-pane scroll">
        <ActiveComponent />
      </div>
    </div>
  );
}
