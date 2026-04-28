import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Kbd({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-medium rounded border border-[var(--border-raw)] border-b-2 bg-[var(--bg-elev)] text-[var(--fg-muted)]",
        className,
      )}
      {...props}
    />
  );
}
