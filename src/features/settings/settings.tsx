import { useState } from "react";
import { useTheme } from "./hooks/use-theme";
import { THEMES, type ThemeId } from "./themes";
import { ProvidersPane } from "./components/providers-pane";
import { Badge } from "./components/ui";
import { cardSurface } from "./components/ui/card";
import { cn } from "./lib/utils";

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
      data-theme-id={id}
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        cardSurface,
        "p-3.5 flex flex-col gap-2.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-elev-2)]",
        active &&
          "border-[var(--accent-raw)] bg-[var(--accent-soft)] shadow-[inset_0_0_0_1px_var(--accent-raw)] hover:bg-[var(--accent-soft)]",
      )}
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="text-[13px] font-semibold text-[var(--fg)]">
          {label}
        </span>
        {active ? <Badge>active</Badge> : null}
      </div>
      <p className="text-[11.5px] text-[var(--fg-muted)] leading-[1.4] min-h-[32px] m-0">
        {description}
      </p>
      <div className="flex gap-1" aria-hidden>
        {swatches.map((color, i) => (
          <span
            key={`${id}-${i}`}
            className="w-5 h-5 rounded border border-[var(--border-subtle)]"
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
