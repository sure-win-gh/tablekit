import type { Metadata } from "next";

import { CtaBand } from "@/components/marketing/cta-band";
import { CtaLink } from "@/components/marketing/cta-link";
import { JsonLd } from "@/components/marketing/json-ld";
import { Section, SectionHeading } from "@/components/marketing/section";
import { TrustLine } from "@/components/marketing/trust-line";
import { buildMetadata } from "@/lib/marketing/seo";
import { DEMO_HREF, DEMO_IS_EXTERNAL } from "@/lib/marketing/site";
import { organizationLd } from "@/lib/marketing/structured-data";

export const metadata: Metadata = buildMetadata({
  title: "Book a 15-min demo — TableKit",
  description:
    "See TableKit in 15 minutes: bookings, deposits, and Reserve with Google for independent UK hospitality. Book a slot that suits you.",
  path: "/demo",
});

// Demo page (demo-scheduler.md). PR 1 renders the link-out only — the
// consent-gated Cal.com embed island lands in the follow-up PR and replaces
// the standalone button below. With NEXT_PUBLIC_DEMO_EMBED_ENABLED off, no CTA
// links here, so this page is reachable only by direct URL; it still works as a
// plain link-out to whatever DEMO_HREF resolves to (a scheduler link or the
// mailto fallback).
export default function DemoPage() {
  return (
    <>
      <JsonLd data={organizationLd()} />

      <Section tone="white" className="pt-14 pb-10 sm:pt-20" aria-labelledby="demo-heading">
        <SectionHeading
          id="demo-heading"
          level={1}
          eyebrow="Book a demo"
          title="See TableKit in 15 minutes"
          lead="A quick, no-pressure walkthrough of bookings, deposits, and Reserve with Google — tailored to how your venue runs. Pick a time that suits you."
        />
        <div className="mt-10 flex flex-col items-center gap-5">
          <CtaLink href={DEMO_HREF} size="lg" external={DEMO_IS_EXTERNAL}>
            Book a 15-min demo
          </CtaLink>
          <TrustLine align="center" />
        </div>
      </Section>

      <CtaBand
        heading="Prefer to just try it?"
        sub="Start free for up to 50 bookings a month. No card required, cancel anytime."
      />
    </>
  );
}
