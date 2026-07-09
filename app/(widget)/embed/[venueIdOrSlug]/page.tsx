import { notFound } from "next/navigation";

import { widgetDisabled } from "@/lib/feature-flags";
import { captchaEnabled } from "@/lib/public/captcha";
import { loadPublicVenueByIdOrSlug } from "@/lib/public/venue";
import { hasPlan } from "@/lib/auth/plan-level";
import { widgetThemeStyle } from "@/lib/branding/theme";

import { WidgetHeader, WidgetThemeProvider } from "../../book/[venueIdOrSlug]/branding";
import { BookingWizard } from "../../book/[venueIdOrSlug]/booking-wizard";
import { EmbedAutoHeight } from "./auto-height";

// Iframe target for the embeddable widget. Runs the same conversational
// booking wizard as the hosted page, minus the cookie banner (parent site
// owns consent) and plus EmbedAutoHeight so the loader sizes the iframe to the
// changing step height.

export const dynamic = "force-dynamic";

type SearchParams = {
  date?: string;
  party?: string;
  serviceId?: string;
  wallStart?: string;
  month?: string;
  // Campaign attribution param from marketing email links (Phase B).
  tk_c?: string;
};

export async function generateMetadata({ params }: { params: Promise<{ venueIdOrSlug: string }> }) {
  const { venueIdOrSlug } = await params;
  const lookup = await loadPublicVenueByIdOrSlug(venueIdOrSlug);
  return { title: lookup ? `Book at ${lookup.venue.name}` : "Book" };
}

export default async function EmbedBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueIdOrSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { venueIdOrSlug } = await params;
  const sp = await searchParams;
  const lookup = await loadPublicVenueByIdOrSlug(venueIdOrSlug);
  if (!lookup) notFound();
  const { venue, plan, branding } = lookup;
  // The embed deliberately does NOT redirect UUID → slug — the iframe URL is
  // set once by the loader script and a redirect would flash the iframe.

  // Plus-gated theming. The themed wrapper uses display:contents so
  // EmbedAutoHeight still measures the exact content height.
  const isPlus = hasPlan(plan, "plus");
  const themeStyle = widgetThemeStyle(branding, { gated: isPlus });
  const logoUrl = isPlus ? (branding?.logoUrl ?? null) : null;
  const captchaSitekey = captchaEnabled()
    ? (process.env["NEXT_PUBLIC_HCAPTCHA_SITEKEY"] ?? null)
    : null;

  if (widgetDisabled()) {
    return (
      <WidgetThemeProvider style={themeStyle}>
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          <h1 className="text-ink text-xl font-bold tracking-tight">{venue.name}</h1>
          <p className="rounded-card border-hairline bg-cloud text-charcoal border p-4 text-sm">
            Online booking is temporarily unavailable. Please contact the venue directly.
          </p>
          <EmbedAutoHeight />
        </main>
      </WidgetThemeProvider>
    );
  }

  return (
    <WidgetThemeProvider style={themeStyle}>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4">
        <WidgetHeader variant="embed" venueName={venue.name} logoUrl={logoUrl} />

        <BookingWizard
          venue={venue}
          basePath={`/embed/${venueIdOrSlug}`}
          captchaSitekey={captchaSitekey}
          sp={sp}
        />

        <EmbedAutoHeight />
      </main>
    </WidgetThemeProvider>
  );
}
