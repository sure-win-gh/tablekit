import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

import { cn } from "./cn";

// Card is the base content container. Default rendering is a flat
// white surface with a 1px hairline border — Airbnb's listing-card
// pattern, used everywhere on the dashboard. The `elevated` variant
// applies the three-layer panel shadow for popovers + modal-like
// surfaces; default cards stay flat so a long page doesn't
// accumulate visual noise.

type CardProps = HTMLAttributes<HTMLDivElement> & {
  elevated?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
};

const PAD: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { elevated = false, padding = "none", className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-card border-hairline border bg-white",
        elevated && "shadow-panel",
        PAD[padding],
        className,
      )}
      {...rest}
    />
  );
});

// Optional sub-parts for cards that want a separated header. Most
// surfaces don't need these; the bookings/reports pages do.
export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-hairline flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3",
        className,
      )}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-ink text-sm font-semibold tracking-tight", className)} {...rest} />
  );
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-ash text-xs", className)} {...rest} />;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...rest} />;
}
