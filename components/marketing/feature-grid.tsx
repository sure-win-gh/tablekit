import type { MarketingFeature } from "@/lib/marketing/features";
import { FeatureCard } from "./feature-card";

export function FeatureGrid({ features }: { features: MarketingFeature[] }) {
  return (
    <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {features.map((feature) => (
        <li key={feature.slug} className="h-full">
          <FeatureCard feature={feature} />
        </li>
      ))}
    </ul>
  );
}
