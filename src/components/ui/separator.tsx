import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

interface SeparatorProps extends HTMLAttributes<HTMLSpanElement> {
  readonly orientation?: "horizontal" | "vertical";
}

export function Separator({
  orientation = "horizontal",
  className,
  ...props
}: SeparatorProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-[var(--border-subtle)] shrink-0 block",
        orientation === "vertical" ? "w-px self-stretch my-1.5 mx-1" : "h-px w-full",
        className,
      )}
      {...props}
    />
  );
}
