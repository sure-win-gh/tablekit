import type { MetadataRoute } from "next";

import { LIVE_FEATURES } from "@/lib/marketing/features";
import { SITE } from "@/lib/marketing/site";

// Public, indexable URLs only. Token/DSAR pages self-noindex via their own
// metadata and the dashboard is disallowed in robots, so neither belongs
// here. Feature detail pages come straight from the registry, so the
// sitemap can't drift from what actually exists.

export default function sitemap(): MetadataRoute.Sitemap {
  const abs = (path: string) => new URL(path, SITE.url).toString();

  const marketing: MetadataRoute.Sitemap = [
    { url: abs("/"), changeFrequency: "weekly", priority: 1 },
    { url: abs("/pricing"), changeFrequency: "weekly", priority: 0.9 },
    { url: abs("/features"), changeFrequency: "weekly", priority: 0.8 },
    ...LIVE_FEATURES.map((feature) => ({
      url: abs(`/features/${feature.slug}`),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];

  const legal: MetadataRoute.Sitemap = [
    { url: abs("/privacy"), changeFrequency: "yearly", priority: 0.3 },
    { url: abs("/security"), changeFrequency: "yearly", priority: 0.3 },
    { url: abs("/legal"), changeFrequency: "yearly", priority: 0.2 },
    { url: abs("/legal/sub-processors"), changeFrequency: "yearly", priority: 0.2 },
    { url: abs("/docs/api"), changeFrequency: "monthly", priority: 0.3 },
  ];

  return [...marketing, ...legal];
}
