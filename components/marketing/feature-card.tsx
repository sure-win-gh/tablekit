import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui";
import type { MarketingFeature } from "@/lib/marketing/features";
import { MarketingIcon } from "@/lib/marketing/icon";
import { TierBadge } from "./tier-badge";

// A single feature, benefit-led: outcome (or tagline) leads, the feature
// name supports. Live features link to their deep-dive; coming-soon ones
// show a badge instead of a dead link.

export function FeatureCard({ feature }: { feature: MarketingFeature }) {
  const heading = feature.outcome ?? feature.name;
  const isLink = feature.status === "live";

  const inner = (
    <Card
      padding="lg"
      className="flex h-full flex-col gap-3 transition group-hover:border-ink/30"
    >
      <div className="flex items-center justify-between">
        <span className="bg-coral/10 text-coral flex size-10 items-center justify-center rounded-pill">
          <MarketingIcon name={feature.icon} className="size-5" />
        </span>
        <TierBadge tier={feature.tier} />
      </div>
      <div className="flex-1">
        <h3 className="text-ink font-semibold tracking-tight">{heading}</h3>
        <p className="text-ash mt-1.5 text-sm text-pretty">{feature.tagline}</p>
      </div>
      {isLink ? (
        <span className="text-coral inline-flex items-center gap-1 text-sm font-semibold">
          {feature.name}
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
        </span>
      ) : (
        <span className="text-mute text-sm font-medium">Coming soon</span>
      )}
    </Card>
  );

  if (!isLink) return <div className="group">{inner}</div>;

  return (
    <Link
      href={`/features/${feature.slug}`}
      className="group rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
    >
      {inner}
    </Link>
  );
}
