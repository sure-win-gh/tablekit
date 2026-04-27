import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { getAccount } from "@/lib/stripe/connect";
import { withUser } from "@/lib/db/client";
import { venueOauthConnections, venues } from "@/lib/db/schema";
import { listAccounts, listLocations } from "@/lib/google/business-profile";
import { getActiveGoogleConnection } from "@/lib/google/connection";
import { isConfigured as googleOauthConfigured } from "@/lib/oauth/google";

import { BillingSection } from "./billing";
import { GoogleConnectionSection } from "./google-connection";
import { GoogleLocationPicker, type PickerLocation } from "./google-location-picker";
import { VenueSettingsForm } from "./form";

export const metadata = {
  title: "Settings · TableKit",
};

export default async function VenueSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ stripe?: string; google?: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { venueId } = await params;
  const sp = await searchParams;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({
        id: venues.id,
        name: venues.name,
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

  // Stripe Connect state is org-scoped — one connected account per
  // organisation (D1 in the phase plan). The billing section is
  // per-venue in the sense that it lives under a venue URL, but every
  // venue in an org sees the same state.
  const stripeAccount = await getAccount(orgId);

  // Google Business Profile connection state — RLS-scoped read.
  const googleConnection = await withUser(async (db) => {
    const rows = await db
      .select({
        externalAccountId: venueOauthConnections.externalAccountId,
        scopes: venueOauthConnections.scopes,
        tokenExpiresAt: venueOauthConnections.tokenExpiresAt,
        lastSyncedAt: venueOauthConnections.lastSyncedAt,
      })
      .from(venueOauthConnections)
      .where(
        and(
          eq(venueOauthConnections.venueId, venueId),
          eq(venueOauthConnections.provider, "google"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });

  // If the operator has connected but not yet picked a location, fetch
  // the available locations server-side so the picker can render. The
  // active-connection helper handles token refresh transparently.
  let pickerLocations: PickerLocation[] = [];
  let pickerLoadError: string | null = null;
  if (googleConnection && !googleConnection.externalAccountId) {
    try {
      const conn = await getActiveGoogleConnection(venueId);
      if (!conn) {
        pickerLoadError = "Connection lost. Disconnect and try again.";
      } else {
        const accountsRes = await listAccounts(conn.accessToken);
        if (!accountsRes.ok) {
          pickerLoadError = `Couldn't list Google accounts (HTTP ${accountsRes.status}).`;
        } else {
          // Flatten accounts → locations. Most operators have one
          // account; we don't paginate here because GBP returns all
          // accounts in a single response for the typical case.
          const all: PickerLocation[] = [];
          for (const account of accountsRes.accounts) {
            const locs = await listLocations({
              accessToken: conn.accessToken,
              accountName: account.name,
            });
            if (!locs.ok) continue;
            for (const l of locs.locations) {
              all.push({
                resourceName: `${account.name}/${l.name}`,
                title: l.title,
                address:
                  l.storefrontAddress?.addressLines?.join(", ") ??
                  l.storefrontAddress?.locality ??
                  null,
              });
            }
          }
          pickerLocations = all;
        }
      }
    } catch {
      pickerLoadError = "Couldn't reach Google. Try again.";
    }
  }

  return (
    <section className="flex flex-col gap-8">
      <div>
        <p className="mb-6 text-sm text-ash">
          Venue type is <span className="font-mono text-charcoal">{venue.venueType}</span> —
          changing type isn&apos;t supported yet.
        </p>

        <VenueSettingsForm
          venueId={venue.id}
          name={venue.name}
          timezone={venue.timezone}
          locale={venue.locale}
          reviewRequestEnabled={reviewSettings.enabled}
          reviewRequestDelayHours={reviewSettings.delayHours}
          googlePlaceId={reviewSettings.googlePlaceId}
        />
      </div>

      <BillingSection
        venueId={venue.id}
        account={
          stripeAccount
            ? {
                accountId: stripeAccount.accountId,
                chargesEnabled: stripeAccount.chargesEnabled,
                payoutsEnabled: stripeAccount.payoutsEnabled,
                detailsSubmitted: stripeAccount.detailsSubmitted,
              }
            : null
        }
        flash={sp.stripe ?? null}
      />

      <GoogleConnectionSection
        venueId={venue.id}
        configured={googleOauthConfigured()}
        connection={googleConnection}
        flash={sp.google ?? null}
      />

      {googleConnection && !googleConnection.externalAccountId ? (
        <GoogleLocationPicker
          venueId={venue.id}
          locations={pickerLocations}
          loadError={pickerLoadError}
        />
      ) : null}
    </section>
  );
}
