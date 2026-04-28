import { useMemo, useState } from "react";
import { useProviders } from "../hooks/use-providers";
import { PROVIDER_PRESETS, findPreset } from "../providers/presets";
import {
  AUTH_MODE_LABELS,
  type ProviderConfig,
  type ProviderPreset,
} from "../providers/types";
import { newProviderId } from "../providers/storage";
import { ProviderForm } from "./provider-form";

type Mode =
  | { kind: "list" }
  | { kind: "edit"; draft: ProviderConfig; isNew: boolean };

function draftFromPreset(preset: ProviderPreset): ProviderConfig {
  return {
    id: newProviderId(),
    presetId: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    auth: preset.defaultAuth,
    extraHeaders: [],
    extraParams: [],
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

export function ProvidersPane() {
  const { providers, upsert, remove, toggleEnabled } = useProviders();
  const [mode, setMode] = useState<Mode>({ kind: "list" });

  const sorted = useMemo(
    () => [...providers].sort((a, b) => a.name.localeCompare(b.name)),
    [providers],
  );

  if (mode.kind === "edit") {
    return (
      <ProviderForm
        title={mode.isNew ? `New ${providerLabel(mode.draft)} provider` : `Edit ${mode.draft.name}`}
        initial={mode.draft}
        onCancel={() => setMode({ kind: "list" })}
        onSave={(config) => {
          upsert(config);
          setMode({ kind: "list" });
        }}
        onDelete={
          mode.isNew
            ? undefined
            : () => {
                remove(mode.draft.id);
                setMode({ kind: "list" });
              }
        }
      />
    );
  }

  return (
    <section className="providers-pane">
      <h2 className="settings-section-title">LLM providers</h2>
      <p className="settings-section-desc">
        Configure where helix sends model requests. Each provider stores its
        base URL, auth mode, and optional extra headers or body params
        (extra_params). Pick a preset below or add a fully custom endpoint.
      </p>

      <div className="providers-section-label">Configured</div>
      {sorted.length === 0 ? (
        <p className="providers-empty">
          No providers configured yet. Pick a preset below to get started.
        </p>
      ) : (
        <ul className="providers-list">
          {sorted.map((p) => (
            <li key={p.id} className="provider-row" data-disabled={!p.enabled || undefined}>
              <button
                type="button"
                className="provider-row-main"
                onClick={() =>
                  setMode({ kind: "edit", draft: p, isNew: false })
                }
              >
                <div className="provider-row-head">
                  <span className="provider-row-name">{p.name}</span>
                  <span className="provider-row-badge">
                    {AUTH_MODE_LABELS[p.auth.mode]}
                  </span>
                </div>
                <div className="provider-row-meta">
                  <span className="provider-row-url">
                    {p.baseUrl || <em>no base URL set</em>}
                  </span>
                  {p.model ? (
                    <>
                      <span className="provider-row-sep">·</span>
                      <span className="provider-row-model">{p.model}</span>
                    </>
                  ) : null}
                </div>
              </button>
              <div className="provider-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => toggleEnabled(p.id)}
                  aria-pressed={p.enabled}
                >
                  {p.enabled ? "Enabled" : "Disabled"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="providers-section-label">Add provider</div>
      <ul className="preset-grid">
        {PROVIDER_PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              className="preset-card"
              onClick={() =>
                setMode({
                  kind: "edit",
                  draft: draftFromPreset(preset),
                  isNew: true,
                })
              }
            >
              <span className="preset-card-name">{preset.name}</span>
              <span className="preset-card-desc">{preset.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function providerLabel(p: ProviderConfig): string {
  return findPreset(p.presetId)?.name ?? "Custom";
}
