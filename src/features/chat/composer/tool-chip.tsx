import type { ReactNode, Ref } from "react";
import { ChevronDownIcon } from "./icons";

interface ToolChipProps {
  readonly icon: ReactNode;
  readonly label: string;
  /** Either a plain count (`5`) or a ratio string (`5/8`). gcf-desktop uses
   * the ratio for tools/prompts so a quick glance shows how much of what's
   * available is currently in play. */
  readonly count: number | string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  /** Override the default `title` string. The MCP chip falls back to a
   * connection-aware default; built-in / future chips can supply their own. */
  readonly tooltip?: string;
}

export function ToolChip({
  icon,
  label,
  count,
  active,
  disabled,
  onClick,
  buttonRef,
  tooltip,
}: ToolChipProps) {
  const title =
    tooltip ??
    (disabled
      ? `${label} — connect an MCP server in Settings → MCP`
      : `${label} from connected MCP servers`);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="tool-chip"
      data-active={active || undefined}
      data-disabled={disabled || undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="tool-chip-icon" aria-hidden>
        {icon}
      </span>
      {label}
      <span className="tool-chip-count">{count}</span>
      <ChevronDownIcon />
    </button>
  );
}
