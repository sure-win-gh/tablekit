// Renders a JSON-LD <script> for structured data (Organization, WebSite,
// Product/Offer, FAQPage, BreadcrumbList). Server-only; the payload is our
// own static data, not user input, so stringifying it is safe. We escape
// "<" defensively to avoid any chance of breaking out of the script tag.

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
