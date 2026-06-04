import { and, eq } from "drizzle-orm";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { venueOauthConnections } from "@/lib/db/schema";
import { listAccounts, listLocations } from "@/lib/google/business-profile";
import { getActiveGoogleConnection } from "@/lib/google/connection";
import { isConfigured as googleOauthConfigured } from "@/lib/oauth/google";

import { GoogleConnectionSection } from "../google-connection";
import { GoogleLocationPicker, type PickerLocation } from "../google-location-picker";

export const metadata = { title: "Google · TableKit" };

export default async function GoogleSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ google?: string }>;
}) {
  await requireRole("manager");
  const { venueId } = await params;
  const sp = await searchParams;

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
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Google</h2>
        <p className="text-ash mt-0.5 text-sm">
          Connect your Google Business Profile to sync reviews and reply from TableKit.
        </p>
      </div>

      <GoogleConnectionSection
        venueId={venueId}
        configured={googleOauthConfigured()}
        connection={googleConnection}
        flash={sp.google ?? null}
      />

      {googleConnection && !googleConnection.externalAccountId ? (
        <GoogleLocationPicker
          venueId={venueId}
          locations={pickerLocations}
          loadError={pickerLoadError}
        />
      ) : null}
    </section>
  );
}
