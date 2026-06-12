import type { Metadata } from "next";

import { SITE } from "./site";

// Per-page metadata builder. metadataBase is set once in the root layout,
// so canonical/OG URLs here can be relative paths. The OG/Twitter images
// are supplied automatically by each route's opengraph-image.tsx (Next's
// file convention), so we don't hand-set image URLs.

export function buildMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  /** Absolute-from-root path, e.g. "/pricing". */
  path: string;
}): Metadata {
  return {
    // Absolute so the root layout's title template never double-wraps the
    // fully-composed titles we craft per page for search intent.
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title,
      description,
      url: path,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}
