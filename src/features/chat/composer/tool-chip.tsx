import type { ReactNode, Ref } from "react";
import { ChevronDownIcon } from "./icons";

interface ToolChipProps {
  readonly icon: ReactNode;
  readonly label: string;
  /** Either a plain count (`5`) or a ratio string (`5/8`). gcf-desktop uses
   * the ratio for tools/prompts so a quick glance shows how much of what's
   * available is currently in play. Omit for action chips (e.g.
   * "+ Add context") that don't carry a numeric counter. */
  readonly count?: number | string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  /** Override the default `title` string. The MCP chip falls back to a
   * connection-aware default; built-in / future chips can supply their own. */
  readonly tooltip?: string;
  /** "primary" promotes the chip as the headline action of the row — used
   * by +Add context per the design spec. Renders with a dashed border + fg
   * color when not active so it reads as a CTA, not a status indicator. */
  readonly variant?: "default" | "primary";
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
  variant = "default",
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
      data-variant={variant === "primary" ? "primary" : undefined}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="tool-chip-icon" aria-hidden>
        {icon}
      </span>
      {label}
      {count !== undefined ? (
        <>
          <span className="tool-chip-count">{count}</span>
          <ChevronDownIcon />
        </>
      ) : null}
    </button>
  );
}
