import { LIVE_FEATURES, featureBySlug } from "@/lib/marketing/features";
import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/marketing/og";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = "TableKit feature";

export function generateStaticParams() {
  return LIVE_FEATURES.map((feature) => ({ slug: feature.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const feature = featureBySlug(slug);
  return renderOgImage({
    eyebrow: "Feature",
    title: feature?.outcome ?? feature?.name ?? "TableKit",
  });
}
