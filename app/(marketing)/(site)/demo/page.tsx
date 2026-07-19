import type { Metadata } from "next";

import { CtaBand } from "@/components/marketing/cta-band";
import { CtaLink } from "@/components/marketing/cta-link";
import { DemoScheduler } from "@/components/marketing/demo-scheduler";
import { JsonLd } from "@/components/marketing/json-ld";
import { Section, SectionHeading } from "@/components/marketing/section";
import { TrustLine } from "@/components/marketing/trust-line";
import { buildMetadata } from "@/lib/marketing/seo";
import { DEMO_EMBED_ENABLED, DEMO_HREF, DEMO_IS_EXTERNAL } from "@/lib/marketing/site";
import { organizationLd } from "@/lib/marketing/structured-data";

export const metadata: Metadata = buildMetadata({
  title: "Book a 15-min demo — TableKit",
  description:
    "See TableKit in 15 minutes: bookings, deposits, and Reserve with Google for independent UK hospitality. Book a slot that suits you.",
  path: "/demo",
});

// Demo page (demo-scheduler.md). When NEXT_PUBLIC_DEMO_EMBED_ENABLED is on, the
// CTAs route here and we render the consent-gated Cal.com embed (which itself
// loads nothing third-party until the visitor clicks). When off, no CTA links
// here and a direct visit still works as a plain link-out to whatever DEMO_HREF
// resolves to — so the page degrades gracefully either way.
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
        {DEMO_EMBED_ENABLED ? (
          <div className="mx-auto mt-10 flex w-full max-w-2xl flex-col items-center gap-5">
            <DemoScheduler />
            <TrustLine align="center" />
          </div>
        ) : (
          <div className="mt-10 flex flex-col items-center gap-5">
            <CtaLink href={DEMO_HREF} size="lg" external={DEMO_IS_EXTERNAL}>
              Book a 15-min demo
            </CtaLink>
            <TrustLine align="center" />
          </div>
        )}
      </Section>

      <CtaBand
        heading="Prefer to just try it?"
        sub="Start free for up to 50 bookings a month. No card required, cancel anytime."
      />
    </>
  );
}
