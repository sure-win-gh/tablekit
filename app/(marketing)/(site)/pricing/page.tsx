import type { Metadata } from "next";

import { CtaBand } from "@/components/marketing/cta-band";
import { Faq } from "@/components/marketing/faq";
import { FeatureMatrix } from "@/components/marketing/feature-matrix";
import { JsonLd } from "@/components/marketing/json-ld";
import { PricingTiers } from "@/components/marketing/pricing-tiers";
import { Section, SectionHeading } from "@/components/marketing/section";
import { PRICING_FAQ } from "@/lib/marketing/content";
import { buildMetadata } from "@/lib/marketing/seo";
import { PRICING } from "@/lib/marketing/site";
import { faqPageLd, organizationLd, pricingProductLd } from "@/lib/marketing/structured-data";

export const metadata: Metadata = buildMetadata({
  title: "Pricing — TableKit plans from £29 + VAT, free to start",
  description:
    "TableKit pricing: Free forever for up to 50 bookings a month, Core £29 + VAT, Plus £74 + VAT. No per-cover fees, no contracts. SMS and Stripe fees passed through at cost.",
  path: "/pricing",
});

export default function PricingPage() {
  return (
    <>
      <JsonLd data={organizationLd()} />
      <JsonLd data={pricingProductLd()} />
      <JsonLd data={faqPageLd(PRICING_FAQ)} />

      <Section tone="white" className="pt-14 pb-8 sm:pt-20" aria-labelledby="pricing-heading">
        <SectionHeading
          id="pricing-heading"
          level={1}
          eyebrow="Pricing"
          title="One flat price. Keep every cover."
          lead={`Start free for up to ${PRICING.freeBookingLimit} bookings a month. Paid plans are £29 and £74 + VAT — never a fee per cover. Cancel anytime.`}
        />
        <div className="mt-12">
          <PricingTiers />
        </div>
      </Section>

      <Section tone="cloud" aria-labelledby="matrix-heading">
        <SectionHeading
          id="matrix-heading"
          eyebrow="Compare plans"
          title="What's included on each plan"
          lead="Every plan, every feature, in one place. Higher plans include everything below them."
        />
        <div className="mt-12">
          <FeatureMatrix />
        </div>
      </Section>

      <Section tone="white" aria-labelledby="pricing-faq-heading">
        <SectionHeading
          id="pricing-faq-heading"
          eyebrow="Pricing questions"
          title="The honest answers"
        />
        <div className="mt-10">
          <Faq items={PRICING_FAQ} />
        </div>
      </Section>

      <CtaBand
        heading="Try it free — upgrade only if you need to"
        sub="Free forever up to 50 bookings a month. No card required, cancel anytime."
      />
    </>
  );
}
