import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

/** shadcn-style Button.
 *
 * Variants are bound to helix's CSS-variable theme tokens via Tailwind's
 * arbitrary-value syntax (e.g. `bg-[var(--bg-elev)]`). That preserves the
 * data-theme switching behaviour — the same utility flips colours when the
 * `data-theme` attribute changes upstream. */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent-raw)] text-[var(--accent-fg)] border border-transparent shadow-[inset_0_1px_0_oklch(1_0_0_/_0.1)] hover:bg-[oklch(from_var(--accent-raw)_calc(l-0.04)_c_h)]",
        outline:
          "border border-[var(--border-raw)] bg-[var(--bg-elev)] text-[var(--fg)] hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)]",
        ghost:
          "text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]",
        // Destructive — quiet at rest (red ink + red hairline border on neutral fill),
        // saturates to solid danger on hover. Reads as dangerous only when reached
        // for. Distinct hue from --accent-raw via the meridian theme tokens
        // (--danger sits at hue 18; the brand accent at hue 25).
        destructive:
          "text-[var(--danger)] bg-[var(--bg-elev)] border border-[oklch(from_var(--danger)_l_c_h_/_0.4)] hover:bg-[var(--danger)] hover:text-[var(--danger-fg)] hover:border-[var(--danger)]",
        // Legacy alias — kept so existing callers still work. Prefer `destructive`.
        danger:
          "text-[var(--danger)] bg-[var(--bg-elev)] border border-[oklch(from_var(--danger)_l_c_h_/_0.4)] hover:bg-[var(--danger)] hover:text-[var(--danger-fg)] hover:border-[var(--danger)]",
        icon:
          "text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]",
      },
      size: {
        default: "h-7 px-3 text-[12px] rounded-[var(--radius)]",
        sm: "h-6 px-2 text-[11px] rounded-[var(--radius)]",
        lg: "h-9 px-4 text-[13px] rounded-[var(--radius)]",
        icon: "h-7 w-7 rounded-[var(--radius)]",
        rail: "h-9 w-9 rounded-[var(--radius)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
