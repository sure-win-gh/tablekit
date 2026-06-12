import { CtaLink } from "./cta-link";
import { TrustLine } from "./trust-line";
import { DEMO_HREF, DEMO_IS_EXTERNAL, SIGNUP_HREF } from "@/lib/marketing/site";

// The repeated closing call-to-action. Same single primary action every
// time (free sign-up), with the demo as the only secondary, and honest
// trust points right beside it. Reused on home and feature pages so the
// CTA appears ≥3× down a long page.

export function CtaBand({
  heading = "Start taking bookings today",
  sub = "Set up your venue in minutes. No card required, cancel anytime.",
}: {
  heading?: string;
  sub?: string;
}) {
  return (
    <section className="bg-ink px-6 py-16 sm:py-20">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-balance text-white sm:text-4xl">
          {heading}
        </h2>
        <p className="text-lg text-pretty text-white/70">{sub}</p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <CtaLink href={SIGNUP_HREF} size="lg">
            Start free — no card needed
          </CtaLink>
          <CtaLink href={DEMO_HREF} variant="secondary" size="lg" external={DEMO_IS_EXTERNAL}>
            Book a 15-min demo
          </CtaLink>
        </div>
        <TrustLine align="center" tone="invert" />
      </div>
    </section>
  );
}
