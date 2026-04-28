import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Canonical shadcn cn() — clsx for conditional classes, twMerge to dedupe
 * conflicting Tailwind utilities (e.g. p-2 + p-4 → p-4). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
