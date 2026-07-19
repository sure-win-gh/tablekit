import type { Metadata } from "next";
import Link from "next/link";

import { CtaBand } from "@/components/marketing/cta-band";
import { CtaLink } from "@/components/marketing/cta-link";
import { Faq } from "@/components/marketing/faq";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { JsonLd } from "@/components/marketing/json-ld";
import { Placeholder } from "@/components/marketing/placeholder";
import { PricingTiers } from "@/components/marketing/pricing-tiers";
import { Section, SectionHeading } from "@/components/marketing/section";
import { Steps } from "@/components/marketing/steps";
import { TrustLine } from "@/components/marketing/trust-line";
import { HOME_FAQ, PROBLEMS } from "@/lib/marketing/content";
import { HOME_FEATURES } from "@/lib/marketing/features";
import { buildMetadata } from "@/lib/marketing/seo";
import { DEMO_CTA_EXTERNAL, DEMO_CTA_HREF, PRICING, SIGNUP_HREF } from "@/lib/marketing/site";
import { faqPageLd, organizationLd, websiteLd } from "@/lib/marketing/structured-data";

export const metadata: Metadata = buildMetadata({
  title: "TableKit — table booking for independent UK hospitality",
  description:
    "A simple, affordable table-booking system for UK cafés, pubs and restaurants. Free for up to 50 bookings a month, paid plans from £29 + VAT. No per-cover fees, no long contracts.",
  path: "/",
});

export default function HomePage() {
  return (
    <>
      <JsonLd data={organizationLd()} />
      <JsonLd data={websiteLd()} />
      <JsonLd data={faqPageLd(HOME_FAQ)} />

      {/* Hero — passes the 5-second test: one outcome headline, one
          subhead, one primary CTA, one supporting visual. */}
      <Section tone="white" className="pt-14 pb-12 sm:pt-20" aria-labelledby="hero-heading">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-coral mb-3 text-sm font-semibold tracking-wide uppercase">
              For independent UK hospitality
            </p>
            <h1
              id="hero-heading"
              className="text-ink text-4xl font-bold tracking-tight text-balance sm:text-5xl"
            >
              Fill more tables. Lose fewer to no-shows.
            </h1>
            <p className="text-ash mt-5 text-lg text-pretty">
              TableKit is table booking built for independent cafés, pubs and restaurants. Free for
              up to {PRICING.freeBookingLimit} bookings a month, paid plans from £29 + VAT — with no
              per-cover fees and no long contracts.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <CtaLink href={SIGNUP_HREF} size="lg">
                Start free — no card needed
              </CtaLink>
              <CtaLink
                href={DEMO_CTA_HREF}
                variant="secondary"
                size="lg"
                external={DEMO_CTA_EXTERNAL}
              >
                Book a 15-min demo
              </CtaLink>
            </div>
            <TrustLine className="mt-6" />
          </div>
          <Placeholder
            caption="App screenshot — the TableKit floor plan mid-service on a tablet, real venue"
            ratio="4/3"
          />
        </div>
      </Section>

      {/* Problem */}
      <Section tone="cloud" aria-labelledby="problem-heading">
        <SectionHeading
          id="problem-heading"
          eyebrow="The trouble with the status quo"
          title="Booking shouldn't cost you covers — or a fortune"
          lead="The big platforms charge per cover and tie you in. TableKit fixes the things that actually cost independents money."
        />
        <ul className="mt-12 grid gap-6 sm:grid-cols-3">
          {PROBLEMS.map((problem) => (
            <li key={problem.title} className="rounded-card border-hairline border bg-white p-6">
              <h3 className="text-ink font-semibold tracking-tight">{problem.title}</h3>
              <p className="text-ash mt-2 text-sm text-pretty">{problem.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* How it works */}
      <Section tone="white" aria-labelledby="how-heading">
        <SectionHeading
          id="how-heading"
          eyebrow="How it works"
          title="Live in an afternoon, not a quarter"
          lead="No installs, no training course, no salesperson. Three steps and you're taking bookings."
        />
        <Steps />
        <div className="mt-12 flex justify-center">
          <CtaLink href={SIGNUP_HREF} size="lg">
            Start free — no card needed
          </CtaLink>
        </div>
      </Section>

      {/* Feature highlights — from the registry */}
      <Section tone="cloud" aria-labelledby="features-heading">
        <SectionHeading
          id="features-heading"
          eyebrow="What you get"
          title="Everything you need to run the floor"
          lead="From taking the booking to seating the guest — and stopping the no-show in between."
        />
        <FeatureGrid features={HOME_FEATURES} />
        <div className="mt-10 text-center">
          <Link
            href="/features"
            className="text-coral inline-flex items-center gap-1 font-semibold hover:underline"
          >
            See all features →
          </Link>
        </div>
      </Section>

      {/* Trust / honest proof band */}
      <Section tone="white" aria-labelledby="trust-heading">
        <SectionHeading
          id="trust-heading"
          eyebrow="Built to be trusted"
          title="Your guests' data, handled properly"
          lead="No fine print games. TableKit is built GDPR-first, hosted in the UK/EU, and priced honestly."
        />
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              h: "No card to start",
              p: "Sign up free and take real bookings without entering a card.",
            },
            {
              h: "Cancel anytime",
              p: "Month-to-month on every paid plan. No contract, no exit fee.",
            },
            {
              h: "UK/EU data residency",
              p: "Your guests' data stays in the UK/EU, encrypted at rest.",
            },
            {
              h: "GDPR-ready",
              p: "Marketing consent off by default; data-subject requests built in.",
            },
          ].map((item) => (
            <li key={item.h} className="rounded-card border-hairline border bg-white p-5">
              <h3 className="text-ink font-semibold tracking-tight">{item.h}</h3>
              <p className="text-ash mt-1.5 text-sm text-pretty">{item.p}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* Pricing teaser — same data as /pricing, anchored on Core */}
      <Section tone="cloud" aria-labelledby="pricing-teaser-heading">
        <SectionHeading
          id="pricing-teaser-heading"
          eyebrow="Simple pricing"
          title="One flat price. No per-cover fees."
          lead="Start free forever. Upgrade only when you outgrow it."
        />
        <div className="mt-12">
          <PricingTiers />
        </div>
        <div className="mt-8 text-center">
          <Link
            href="/pricing"
            className="text-coral inline-flex items-center gap-1 font-semibold hover:underline"
          >
            Compare plans in full →
          </Link>
        </div>
      </Section>

      {/* FAQ */}
      <Section tone="white" aria-labelledby="faq-heading">
        <SectionHeading
          id="faq-heading"
          eyebrow="Questions"
          title="Good questions, honest answers"
        />
        <div className="mt-10">
          <Faq items={HOME_FAQ} />
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
