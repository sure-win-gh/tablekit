import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "./cn";

// Five variants:
//   primary   — coral pill, the single "do it" action per surface.
//   secondary — white pill with hairline border, the safe alternate.
//   ghost     — no background, no border; tertiary in-row action.
//   destructive — coral-text on white, hairline border; cancel/refund.
//   link      — inline anchor-style; for inline text actions.
//
// Two sizes — md (default; 36px tall) and sm (28px). Larger sizes can
// be added when a surface genuinely needs hero scale; the dashboard
// is a working tool, not a marketing page.
//
// Adapted from Airbnb's Reserve-button pattern: pill radius, weight
// 500, no shadow at rest. Active-state scales to 0.97 (a softer
// version of Airbnb's 0.92) so it reads as responsive without feeling
// like the click registered as a hard tap.

type Variant = "primary" | "secondary" | "ghost" | "destructive" | "link";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-coral text-white hover:bg-coral-deep active:scale-[0.97] focus-visible:ring-ink",
  secondary:
    "bg-white text-ink border border-hairline hover:border-ink active:scale-[0.97] focus-visible:ring-ink",
  ghost: "bg-transparent text-ink hover:bg-cloud focus-visible:ring-ink",
  destructive:
    "bg-white text-rose border border-hairline hover:border-rose hover:text-rose-deep focus-visible:ring-rose",
  link: "bg-transparent text-ink underline underline-offset-4 hover:text-coral focus-visible:ring-coral",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-3 text-xs",
  md: "h-9 px-4 text-sm",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "rounded-pill inline-flex items-center justify-center gap-1.5 font-medium transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    />
  );
});

// Circular icon-only button. Common in row actions + nav. Defaults
// to the secondary look (white surface, hairline border) since the
// rest-state coral circle reads as too loud for a working tool.
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { size?: Size; "aria-label": string }
>(function IconButton({ size = "md", className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "text-ink inline-flex items-center justify-center rounded-full bg-white",
        "border-hairline hover:border-ink border transition active:scale-[0.97]",
        "focus-visible:ring-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        size === "sm" ? "h-7 w-7" : "h-9 w-9",
        className,
      )}
      {...rest}
    />
  );
});
