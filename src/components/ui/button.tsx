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
          "bg-[var(--accent-raw)] text-[var(--accent-fg)] border border-transparent hover:opacity-90",
        outline:
          "border border-[var(--border-raw)] bg-[var(--bg-elev)] text-[var(--fg)] hover:border-[var(--accent-ring)] hover:bg-[var(--accent-soft)]",
        ghost:
          "text-[var(--fg-muted)] border border-transparent hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]",
        danger:
          "text-[var(--danger)] border border-transparent hover:bg-[oklch(from_var(--danger)_l_c_h_/_0.1)]",
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
