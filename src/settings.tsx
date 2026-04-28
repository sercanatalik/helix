import { useState } from "react";
import { useTheme } from "./hooks/use-theme";
import { THEMES, type ThemeId } from "./themes";
import { ProvidersPane } from "./components/providers-pane";

type SettingsTab = "appearance" | "providers" | "general";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "providers", label: "Providers" },
  { id: "general", label: "General" },
];

export function Settings() {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="settings-nav-item"
            data-active={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-pane scroll">
        {tab === "appearance" ? (
          <AppearancePane />
        ) : tab === "providers" ? (
          <ProvidersPane />
        ) : (
          <GeneralPane />
        )}
      </div>
    </div>
  );
}

function AppearancePane() {
  const { theme, setTheme } = useTheme();
  return (
    <section>
      <h2 className="settings-section-title">Theme</h2>
      <p className="settings-section-desc">
        The app default mirrors gcf-desktop's dark palette. Themes are modular —
        each is a single CSS file under <code>src/themes/</code> registered in{" "}
        <code>src/themes/index.ts</code>.
      </p>
      <div className="theme-grid">
        {THEMES.map((descriptor) => (
          <ThemeCard
            key={descriptor.id}
            id={descriptor.id}
            label={descriptor.label}
            description={descriptor.description}
            swatches={descriptor.swatches}
            active={theme === descriptor.id}
            onSelect={() => setTheme(descriptor.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ThemeCard({
  id,
  label,
  description,
  swatches,
  active,
  onSelect,
}: {
  readonly id: ThemeId;
  readonly label: string;
  readonly description: string;
  readonly swatches: readonly string[];
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="theme-card"
      data-active={active || undefined}
      data-theme-id={id}
      onClick={onSelect}
      aria-pressed={active}
    >
      <div className="theme-card-head">
        <span className="theme-card-name">{label}</span>
        {active ? <span className="theme-card-badge">active</span> : null}
      </div>
      <p className="theme-card-desc">{description}</p>
      <div className="theme-swatches" aria-hidden>
        {swatches.map((color, i) => (
          <span
            key={`${id}-${i}`}
            className="theme-swatch"
            style={{ background: color }}
          />
        ))}
      </div>
    </button>
  );
}

function GeneralPane() {
  return (
    <section>
      <h2 className="settings-section-title">General</h2>
      <p className="settings-section-desc">
        Backend and integration settings will live here once the MCP layer is
        wired up.
      </p>
    </section>
  );
}
