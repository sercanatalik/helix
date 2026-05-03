import { ChevronDownIcon, CloseIcon, CpuIcon, RefreshIcon } from "./icons";

interface ModelChipProps {
  readonly activeModel: string | undefined;
  readonly models: readonly string[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly fromEndpoint: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly onPick: (model: string) => void;
  readonly onRefresh: () => void;
}

/** Inline model picker chip. The label shows the active model id (truncated)
 * and a chevron; clicking opens a popover with discovered models. When the
 * `/models` endpoint isn't reachable we fall back to the provider's default
 * model and surface the failure as a quiet hint inside the popover. */
export function ModelChip({
  activeModel,
  models,
  isLoading,
  error,
  fromEndpoint,
  open,
  onToggle,
  onClose,
  onPick,
  onRefresh,
}: ModelChipProps) {
  return (
    <span className="model-chip-wrap">
      <button
        type="button"
        className="tool-chip model-chip"
        data-active={open || undefined}
        title={activeModel ? `Model: ${activeModel}` : "Pick a model"}
        onClick={onToggle}
      >
        <span className="tool-chip-icon" aria-hidden>
          <CpuIcon />
        </span>
        <span className="model-chip-label">
          {activeModel ?? "Pick a model"}
        </span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="model-menu" role="dialog" aria-label="Pick a model">
          <header className="mcp-menu-head">
            <div>
              <div className="mcp-menu-title">
                Models
                {models.length > 0 ? (
                  <span className="mcp-menu-count">{models.length}</span>
                ) : null}
              </div>
              <div className="mcp-menu-hint">
                {isLoading
                  ? "Fetching from /models…"
                  : fromEndpoint
                    ? "From provider /models endpoint"
                    : error
                      ? `/models unavailable — using provider default${
                          error ? ` (${error})` : ""
                        }`
                      : "No /models endpoint — using provider default"}
              </div>
            </div>
            <button
              type="button"
              className="mcp-menu-close"
              onClick={() => {
                onRefresh();
              }}
              aria-label="Refresh models"
              title="Refresh"
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="mcp-menu-close"
              onClick={onClose}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </header>
          {models.length === 0 ? (
            <p className="mcp-menu-empty">
              No models available. Set a default model on the provider in
              Settings → Providers.
            </p>
          ) : (
            <ul className="mcp-menu-items model-menu-items">
              {models.map((m) => (
                <li
                  key={m}
                  role="option"
                  aria-selected={m === activeModel}
                  className="mcp-menu-item mcp-menu-item-action"
                  data-active={m === activeModel || undefined}
                >
                  <button
                    type="button"
                    className="mcp-menu-item-body"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(m);
                    }}
                  >
                    <span className="mcp-menu-item-text">
                      <code className="mcp-menu-item-name">{m}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}
