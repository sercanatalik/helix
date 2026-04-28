import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** Tailwind utilities defining the Card surface. Exported so non-div
 * elements (a `<button>`, an `<a>`) can wear the same surface without
 * needing a polymorphic Card or a Radix Slot. */
export const cardSurface =
  "border border-[var(--border-raw)] bg-[var(--bg-elev)] text-[var(--fg)] rounded-[calc(var(--radius)*2)] overflow-hidden";

/** Card surface — sits on `--bg-elev`, hairline border, radius 2× the theme
 * radius (matches the proposal's Card shape). */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return <div ref={ref} className={cn(cardSurface, className)} {...props} />;
  },
);

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 px-4 pt-3 pb-2 border-b border-[var(--border-subtle)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-[12px] font-semibold tracking-[-0.005em] text-[var(--fg)] m-0",
        className,
      )}
      {...props}
    />
  );
}

export function CardMeta({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--fg-dim)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}
