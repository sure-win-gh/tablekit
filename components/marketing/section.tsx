import type { ElementType, ReactNode } from "react";

import { cn } from "@/components/ui";

// Layout primitive for marketing pages: a centered, max-width container
// with consistent vertical rhythm and an optional soft band background.
// Warmth comes from space and alternating bands rather than new colours —
// `cloud` is the existing soft neutral; coral is reserved for actions.

type Tone = "white" | "cloud";

const TONE: Record<Tone, string> = {
  white: "bg-white",
  cloud: "bg-cloud",
};

export function Section({
  children,
  tone = "white",
  as: Tag = "section",
  className,
  innerClassName,
  ...rest
}: {
  children: ReactNode;
  tone?: Tone;
  as?: ElementType;
  className?: string;
  innerClassName?: string;
} & { id?: string; "aria-labelledby"?: string }) {
  return (
    <Tag className={cn(TONE[tone], "px-6 py-16 sm:py-20", className)} {...rest}>
      <div className={cn("mx-auto w-full max-w-5xl", innerClassName)}>{children}</div>
    </Tag>
  );
}

// Standard centered section heading: small coral eyebrow, large ink
// display heading, optional lead paragraph. Defaults to <h2>; a page's
// hero passes level={1} so every page has exactly one <h1>.
export function SectionHeading({
  eyebrow,
  title,
  lead,
  id,
  align = "center",
  level = 2,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  id?: string;
  align?: "center" | "start";
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      {eyebrow && (
        <p className="text-coral mb-2 text-sm font-semibold tracking-wide uppercase">{eyebrow}</p>
      )}
      <Heading
        id={id}
        className="text-ink text-3xl font-bold tracking-tight text-balance sm:text-4xl"
      >
        {title}
      </Heading>
      {lead && <p className="text-ash mt-4 text-lg text-pretty">{lead}</p>}
    </div>
  );
}
