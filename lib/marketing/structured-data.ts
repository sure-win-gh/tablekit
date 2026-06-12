// Builders for the JSON-LD we emit. Facts are sourced from site.ts and the
// pricing/registry data so the structured data can't drift from the visible
// copy — the same accuracy rule as the GEO standards.

import type { Faq } from "./content";
import { PLANS } from "./tiers";
import { PRICING, SITE } from "./site";

function abs(path: string): string {
  return new URL(path, SITE.url).toString();
}

export function organizationLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    email: SITE.contactEmail,
    description: SITE.oneLiner,
    areaServed: "GB",
  };
}

export function websiteLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: SITE.url,
    description: SITE.tagline,
  };
}

// Product with one Offer per plan. Prices are VAT-exclusive (valueAddedTaxIncluded
// false makes that explicit and machine-readable).
export function pricingProductLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${SITE.name} table booking software`,
    description: SITE.oneLiner,
    brand: { "@type": "Brand", name: SITE.name },
    offers: PLANS.map((plan) => ({
      "@type": "Offer",
      name: `${SITE.name} ${plan.name}`,
      price: (plan.pricePerMonth ?? 0).toFixed(2),
      priceCurrency: PRICING.currency,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: (plan.pricePerMonth ?? 0).toFixed(2),
        priceCurrency: PRICING.currency,
        valueAddedTaxIncluded: false,
        unitText: "MONTH",
      },
      url: abs("/pricing"),
      availability: "https://schema.org/InStock",
    })),
  };
}

export function faqPageLd(faqs: Faq[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function breadcrumbLd(
  items: Array<{ name: string; path: string }>,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: abs(item.path),
    })),
  };
}
