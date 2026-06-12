import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/components/ui";

// A link styled as a call-to-action button. The shared Button renders a
// <button>, which can't be a link, so this mirrors its primary/secondary
// looks for anchor semantics — same coral token, so it stays on-system.
// Marketing wants larger touch targets than the dashboard's working-tool
// buttons, hence the md/lg sizes here.
//
// Primary is the single repeated action (free sign-up). Secondary is the
// demo. External targets (mailto / off-site scheduler) render a plain <a>
// with safe rel.

type Variant = "primary" | "secondary";
type Size = "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-coral text-white hover:bg-coral-deep focus-visible:ring-ink",
  secondary: "bg-white text-ink border border-hairline hover:border-ink focus-visible:ring-ink",
};

const SIZE: Record<Size, string> = {
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

export function CtaLink({
  href,
  children,
  variant = "primary",
  size = "md",
  external = false,
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  external?: boolean;
  className?: string;
}) {
  const classes = cn(
    "rounded-pill inline-flex items-center justify-center gap-2 font-semibold transition",
    "active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    VARIANT[variant],
    SIZE[size],
    className,
  );

  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
