import type { HTMLAttributes } from "react";

import { cn } from "./cn";

// Status pills. Variants map to semantic meanings rather than booking
// statuses directly — the bookings page picks the right tone per row
// by passing the matching variant. Shape is the rounded-pill, the
// system's signature.

type Tone =
  | "neutral"
  | "info"
  | "warning"
  | "success"
  | "danger"
  | "muted"
  | "coral";

const TONE: Record<Tone, string> = {
  neutral: "bg-cloud text-charcoal",
  info: "bg-blue-50 text-blue-800",
  warning: "bg-amber-50 text-amber-800",
  success: "bg-emerald-50 text-emerald-800",
  danger: "bg-rose-50 text-rose",
  muted: "bg-cloud text-ash line-through",
  coral: "bg-coral/10 text-coral",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: Tone };

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-semibold",
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}
