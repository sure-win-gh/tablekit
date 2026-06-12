import type { Metadata } from "next";

import { CtaBand } from "@/components/marketing/cta-band";
import { FeatureCard } from "@/components/marketing/feature-card";
import { JsonLd } from "@/components/marketing/json-ld";
import { Section, SectionHeading } from "@/components/marketing/section";
import { FEATURES } from "@/lib/marketing/features";
import { buildMetadata } from "@/lib/marketing/seo";
import { PLANS, type Tier } from "@/lib/marketing/tiers";
import { organizationLd, websiteLd } from "@/lib/marketing/structured-data";

export const metadata: Metadata = buildMetadata({
  title: "Features — everything TableKit does for your venue",
  description:
    "From online bookings and deposits to waitlists, reviews, reporting and an AI enquiry handler — see how TableKit helps independent UK venues fill tables and stop no-shows.",
  path: "/features",
});

const TONE_BY_TIER: Record<Tier, "white" | "cloud"> = {
  free: "white",
  core: "cloud",
  plus: "white",
};

export default function FeaturesPage() {
  return (
    <>
      <JsonLd data={organizationLd()} />
      <JsonLd data={websiteLd()} />

      <Section tone="white" className="pt-14 pb-8 sm:pt-20" aria-labelledby="features-heading">
        <SectionHeading
          id="features-heading"
          eyebrow="Features"
          title="Built to fill tables, not tick boxes"
          lead="Every feature earns its place by saving you time, covers or money. Grouped by the plan it comes with."
        />
      </Section>

      {PLANS.map((plan) => {
        const features = FEATURES.filter((f) => f.tier === plan.tier);
        if (features.length === 0) return null;
        return (
          <Section
            key={plan.tier}
            tone={TONE_BY_TIER[plan.tier]}
            className="py-12 sm:py-14"
            aria-labelledby={`tier-${plan.tier}-heading`}
          >
            <h2
              id={`tier-${plan.tier}-heading`}
              className="text-ink text-2xl font-bold tracking-tight"
            >
              {plan.name}
              <span className="text-ash ml-2 text-base font-medium">{plan.blurb}</span>
            </h2>
            <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <li key={feature.slug} className="h-full">
                  <FeatureCard feature={feature} />
                </li>
              ))}
            </ul>
          </Section>
        );
      })}

      <CtaBand />
    </>
  );
}
