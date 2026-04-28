// helix-ai · theme registry.
//
// Registering a new theme: drop a CSS file next to this one that sets the
// token contract on `:root[data-theme="<id>"]`, import it in this file, then
// append a metadata entry to `THEMES`. The settings page reads from this
// registry and renders one card per theme — no other code changes required.

import "./dark.css";
import "./light.css";
import "./meridian-dark.css";
import "./meridian-light.css";

export type ThemeId = "dark" | "light" | "meridian-dark" | "meridian-light";

export interface ThemeDescriptor {
  readonly id: ThemeId;
  readonly label: string;
  readonly description: string;
  /** Compact preview swatches the settings card paints. */
  readonly swatches: readonly string[];
}

export const THEMES: readonly ThemeDescriptor[] = [
  {
    id: "dark",
    label: "Dark",
    description: "gcf-desktop default. Warm neutrals on near-black.",
    swatches: ["#262a31", "#34393f", "#8fbf95"],
  },
  {
    id: "light",
    label: "Light",
    description: "gcf-desktop light. Warm neutrals on off-white.",
    swatches: ["#f7f6f4", "#e9e7e3", "#5d8c63"],
  },
  {
    id: "meridian-dark",
    label: "Meridian Dark",
    description:
      "Cool deep navy, hairline borders, single restrained crimson accent.",
    swatches: ["#1f2632", "#2c3340", "#cc4f3e"],
  },
  {
    id: "meridian-light",
    label: "Meridian Light",
    description:
      "Paper-cool off-white, deep navy ink, the same crimson accent.",
    swatches: ["#f6f6f9", "#ffffff", "#a93927"],
  },
];

export const DEFAULT_THEME: ThemeId = "meridian-light";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((t) => t.id === value);
}
