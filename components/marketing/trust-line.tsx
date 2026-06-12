import { Check } from "lucide-react";

import { cn } from "@/components/ui";
import { TRUST_POINTS } from "@/lib/marketing/site";

// The honest-proof strip shown next to every primary CTA: no card,
// cancel anytime, UK residency, GDPR. Not social proof — proof we can
// actually stand behind.
//
// `tone` is an explicit prop rather than a className override because our
// cn() doesn't resolve Tailwind conflicts, so a passed-in text colour
// can't reliably beat a default one.

export function TrustLine({
  className,
  align = "start",
  tone = "default",
}: {
  className?: string;
  align?: "start" | "center";
  tone?: "default" | "invert";
}) {
  return (
    <ul
      className={cn(
        "flex flex-wrap gap-x-4 gap-y-1.5 text-xs",
        tone === "invert" ? "text-white/70" : "text-ash",
        align === "center" && "justify-center",
        className,
      )}
    >
      {TRUST_POINTS.map((point) => (
        <li key={point} className="inline-flex items-center gap-1.5">
          <Check className="text-coral size-3.5 shrink-0" aria-hidden />
          {point}
        </li>
      ))}
    </ul>
  );
}
