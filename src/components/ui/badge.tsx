import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9.5px] uppercase tracking-[0.08em]",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent-soft)] text-[var(--accent-raw)] border border-[color-mix(in_oklab,var(--accent-raw)_30%,transparent)]",
        outline:
          "border border-[var(--border-raw)] text-[var(--fg-muted)]",
        muted:
          "bg-[var(--bg-elev-2)] text-[var(--fg-muted)] border border-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
