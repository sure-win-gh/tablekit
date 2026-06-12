import type { Metadata } from "next";
import { Check, ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CtaBand } from "@/components/marketing/cta-band";
import { CtaLink } from "@/components/marketing/cta-link";
import { JsonLd } from "@/components/marketing/json-ld";
import { Placeholder } from "@/components/marketing/placeholder";
import { Section } from "@/components/marketing/section";
import { TierBadge } from "@/components/marketing/tier-badge";
import { TrustLine } from "@/components/marketing/trust-line";
import { MarketingIcon } from "@/lib/marketing/icon";
import { LIVE_FEATURES, featureBySlug } from "@/lib/marketing/features";
import { buildMetadata } from "@/lib/marketing/seo";
import { SIGNUP_HREF } from "@/lib/marketing/site";
import { breadcrumbLd } from "@/lib/marketing/structured-data";
import { planByTier } from "@/lib/marketing/tiers";

// Only live features get a deep-dive page; coming-soon features appear in
// the index/matrix but 404 here (no page for something you can't use yet).
export function generateStaticParams() {
  return LIVE_FEATURES.map((feature) => ({ slug: feature.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const feature = featureBySlug(slug);
  if (!feature || feature.status !== "live") return {};
  return buildMetadata({
    title: `${feature.name} — TableKit`,
    description: feature.description,
    path: `/features/${feature.slug}`,
  });
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const feature = featureBySlug(slug);
  if (!feature || feature.status !== "live") notFound();

  const plan = planByTier(feature.tier);
  const headline = feature.outcome ?? feature.name;

  return (
    <>
      <JsonLd
        data={breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Features", path: "/features" },
          { name: feature.name, path: `/features/${feature.slug}` },
        ])}
      />

      <Section tone="white" className="pt-10 pb-12 sm:pt-14" aria-labelledby="feature-heading">
        {/* Visible breadcrumb */}
        <nav aria-label="Breadcrumb" className="text-ash mb-8 flex items-center gap-1.5 text-sm">
          <Link href="/features" className="hover:text-coral transition">
            Features
          </Link>
          <ChevronRight className="size-4" aria-hidden />
          <span className="text-charcoal font-medium">{feature.name}</span>
        </nav>

        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex items-center gap-3">
              <span className="bg-coral/10 text-coral rounded-pill flex size-11 items-center justify-center">
                <MarketingIcon name={feature.icon} className="size-6" />
              </span>
              <TierBadge tier={feature.tier} />
            </div>
            <h1
              id="feature-heading"
              className="text-ink text-4xl font-bold tracking-tight text-balance sm:text-5xl"
            >
              {headline}
            </h1>
            <p className="text-ash mt-5 text-lg text-pretty">{feature.description}</p>
            <div className="mt-8">
              <CtaLink href={SIGNUP_HREF} size="lg">
                Start free — no card needed
              </CtaLink>
            </div>
            <TrustLine className="mt-6" />
            <p className="text-mute mt-4 text-sm">Included on the {plan.name} plan and above.</p>
          </div>
          <Placeholder
            caption={`App screenshot — ${feature.name} in the real TableKit dashboard`}
            ratio="4/3"
          />
        </div>
      </Section>

      {feature.benefits && feature.benefits.length > 0 && (
        <Section tone="cloud" aria-labelledby="benefits-heading">
          <h2
            id="benefits-heading"
            className="text-ink text-center text-2xl font-bold tracking-tight"
          >
            Why operators use it
          </h2>
          <ul className="mx-auto mt-10 grid max-w-3xl gap-4 sm:grid-cols-3">
            {feature.benefits.map((benefit) => (
              <li
                key={benefit}
                className="rounded-card border-hairline flex flex-col gap-2 border bg-white p-5"
              >
                <Check className="text-coral size-5" aria-hidden />
                <span className="text-charcoal text-sm text-pretty">{benefit}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <CtaBand />
    </>
  );
}
