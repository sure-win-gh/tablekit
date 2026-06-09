import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venueSendingDomains, venues } from "@/lib/db/schema";
import { parseProfile } from "@/lib/venues/profile";

import { VenueSettingsForm } from "./form";
import { SendingDomainSection, type SendingDomainRow } from "./sending-domain-section";

export const metadata = {
  title: "Settings · TableKit",
};

export default async function VenueSettingsPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { role } = await requireRole("manager");
  const isOwner = role === "owner";
  const { venueId } = await params;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        venueType: venues.venueType,
        timezone: venues.timezone,
        locale: venues.locale,
        settings: venues.settings,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const publicBaseUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "https://book.tablekit.uk";

  const settings = (venue.settings ?? {}) as Record<string, unknown>;
  const delayHours: 24 | 48 | 72 =
    settings["reviewRequestDelayHours"] === 48
      ? 48
      : settings["reviewRequestDelayHours"] === 72
        ? 72
        : 24;
  const reviewSettings = {
    enabled: settings["reviewRequestEnabled"] !== false,
    delayHours,
    googlePlaceId:
      typeof settings["googlePlaceId"] === "string" ? (settings["googlePlaceId"] as string) : "",
  };

  const escalationThreshold: 1 | 2 | 3 =
    settings["escalationThreshold"] === 1 ? 1 : settings["escalationThreshold"] === 3 ? 3 : 2;
  const escalationSettings = {
    enabled: settings["escalationEnabled"] !== false,
    threshold: escalationThreshold,
    email:
      typeof settings["escalationEmail"] === "string"
        ? (settings["escalationEmail"] as string)
        : "",
  };

  const profile = parseProfile(venue.settings);
  const profileFields = {
    description: profile?.description ?? "",
    cuisine: profile?.cuisine ?? "",
    priceRange: profile?.priceRange ?? "",
    street: profile?.address?.street ?? "",
    city: profile?.address?.city ?? "",
    postcode: profile?.address?.postcode ?? "",
    phone: profile?.phone ?? "",
    website: profile?.website ?? "",
    latitude: profile?.latitude != null ? String(profile.latitude) : "",
    longitude: profile?.longitude != null ? String(profile.longitude) : "",
  };

  const showcaseEnabled = settings["showcaseEnabled"] === true;
  // AI enquiry auto-send — Plus tier only on the surface, but we
  // surface the toggle to every venue and let the runner's
  // requirePlan-equivalent gate (if/when added) refuse. Default off.
  const aiEnquiryAutoSendEnabled = settings["aiEnquiryAutoSendEnabled"] === true;

  // Per-venue sending domain. Optional — most venues use the platform
  // default until they care about "via tablekit.uk" in client UX.
  const sendingDomainRowRaw = await withUser(async (db) => {
    const rows = await db
      .select({
        domain: venueSendingDomains.domain,
        status: venueSendingDomains.status,
        dnsRecords: venueSendingDomains.dnsRecords,
        lastCheckedAt: venueSendingDomains.lastCheckedAt,
      })
      .from(venueSendingDomains)
      .where(eq(venueSendingDomains.venueId, venueId))
      .limit(1);
    return rows[0] ?? null;
  });
  const sendingDomainRow: SendingDomainRow | null = sendingDomainRowRaw
    ? {
        domain: sendingDomainRowRaw.domain,
        status: sendingDomainRowRaw.status as SendingDomainRow["status"],
        records: Array.isArray(sendingDomainRowRaw.dnsRecords)
          ? (sendingDomainRowRaw.dnsRecords as SendingDomainRow["records"])
          : [],
        lastCheckedAt: sendingDomainRowRaw.lastCheckedAt?.toISOString() ?? null,
      }
    : null;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">General</h2>
        <p className="text-ash mt-0.5 text-sm">
          Venue type is <span className="text-charcoal font-mono">{venue.venueType}</span> —
          changing type isn&apos;t supported yet.
        </p>
      </div>

      <VenueSettingsForm
        venueId={venue.id}
        name={venue.name}
        slug={venue.slug ?? ""}
        publicBaseUrl={publicBaseUrl}
        timezone={venue.timezone}
        locale={venue.locale}
        reviewRequestEnabled={reviewSettings.enabled}
        reviewRequestDelayHours={reviewSettings.delayHours}
        googlePlaceId={reviewSettings.googlePlaceId}
        escalationEnabled={escalationSettings.enabled}
        escalationThreshold={escalationSettings.threshold}
        escalationEmail={escalationSettings.email}
        showcaseEnabled={showcaseEnabled}
        aiEnquiryAutoSendEnabled={aiEnquiryAutoSendEnabled}
        profile={profileFields}
      />

      <SendingDomainSection venueId={venue.id} isOwner={isOwner} row={sendingDomainRow} />
    </section>
  );
}
