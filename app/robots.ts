import type { MetadataRoute } from "next";

import { SITE } from "@/lib/marketing/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // The operator app and API aren't marketing surfaces.
      disallow: ["/dashboard", "/api/"],
    },
    sitemap: new URL("/sitemap.xml", SITE.url).toString(),
    host: SITE.url,
  };
}
