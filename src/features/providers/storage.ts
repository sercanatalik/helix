/* helix-ai · provider config persistence.
 *
 * localStorage-backed for now. When the Tauri backend grows a real
 * provider store, swap this module's body without touching the hook.
 */

import type { ProviderConfig, ProviderId } from "./types";

const KEY = "helix.providers.v1";
const ACTIVE_KEY = "helix.active-provider.v1";

export function loadProviders(): readonly ProviderConfig[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ProviderConfig[];
  } catch {
    return [];
  }
}

export function saveProviders(providers: readonly ProviderConfig[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(providers));
  } catch {
    // Quota or privacy mode — best-effort only.
  }
}

export function newProviderId(): string {
  return `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadActiveProviderId(): ProviderId | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(ACTIVE_KEY);
  return raw && raw.length > 0 ? raw : undefined;
}

export function saveActiveProviderId(id: ProviderId | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Best-effort.
  }
}
