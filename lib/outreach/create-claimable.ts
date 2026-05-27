// Orchestration: take a Google Places result + a prospect's contact
// details, build a fully populated (but unclaimed) organisation +
// venue, and return a one-shot claim URL the founder can paste into
// outreach email.
//
// One transaction covers org / venue / areas / tables / services /
// outreach_claims so a token never points at a half-created org.
// Uses adminDb() because the row has no memberships yet — RLS would
// hide it from anyone, which is what we want for unclaimed orgs.
//
// Note we intentionally do NOT create a temporary founder membership.
// Earlier drafts of the plan considered it for RLS-friendly admin UI
// reads, but the admin pages already use adminDb() (platform-admin
// gated, no RLS context) so the simpler "no memberships until claim"
// posture wins. Unclaimed orgs are invisible to authenticated reads
// by construction.

import "server-only";

import { makeOrgSlug } from "@/lib/auth/slug";
import {
  areas,
  organisations,
  outreachClaims,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { PlaceDetails } from "@/lib/google/places";
import {
  buildClaimUrl,
  CLAIM_DEFAULT_TTL_MS,
  generateClaimToken,
} from "@/lib/outreach/claim-token";
import { buildSeedPayload } from "@/lib/outreach/build-from-places";
import { seedSampleBookings } from "@/lib/outreach/seed-bookings";

export type CreateClaimableInput = {
  place: PlaceDetails;
  prospectEmail: string;
  prospectName?: string;
  // The founder (or future platform admin) hitting "Create".
  createdByUserId: string;
  // Where the prospect lives — `NEXT_PUBLIC_APP_URL` from the caller.
  appUrl: string;
  // Override only set by tests to make assertions deterministic.
  now?: () => Date;
};

export type CreateClaimableResult = {
  organisationId: string;
  venueId: string;
  claimToken: string; // plaintext — return-once
  claimUrl: string;
  expiresAt: Date;
};

export async function createClaimableAccount(
  input: CreateClaimableInput,
): Promise<CreateClaimableResult> {
  const now = (input.now ?? (() => new Date()))();
  const seed = buildSeedPayload(input.place);
  const { token, tokenHash } = generateClaimToken();
  const expiresAt = new Date(now.getTime() + CLAIM_DEFAULT_TTL_MS);

  const orgSlug = makeOrgSlug(seed.organisation.name);
  const db = adminDb();

  const { organisationId, venueId } = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organisations)
      .values({
        name: seed.organisation.name,
        slug: orgSlug,
        outreachSource: seed.organisation.outreachSource,
        // claimedAt deliberately omitted (NULL) — the purge cron and
        // claim flow both key off this being NULL.
      })
      .returning({ id: organisations.id });
    if (!org) throw new Error("createClaimableAccount: organisation insert returned no row");

    const [venueRow] = await tx
      .insert(venues)
      .values({
        organisationId: org.id,
        name: seed.venue.name,
        venueType: seed.venue.venueType,
      })
      .returning({ id: venues.id });
    if (!venueRow) throw new Error("createClaimableAccount: venue insert returned no row");

    for (const area of seed.areas) {
      const [areaRow] = await tx
        .insert(areas)
        .values({
          // organisation_id overwritten by enforce_areas_org_id trigger;
          // passed only to satisfy the notNull TS type. Same as the
          // existing createVenue action.
          organisationId: org.id,
          venueId: venueRow.id,
          name: area.name,
        })
        .returning({ id: areas.id });
      if (!areaRow) throw new Error("createClaimableAccount: area insert returned no row");

      for (const table of area.tables) {
        await tx.insert(venueTables).values({
          organisationId: org.id,
          venueId: venueRow.id,
          areaId: areaRow.id,
          label: table.label,
          minCover: table.minCover,
          maxCover: table.maxCover,
          position: table.position,
        });
      }
    }

    for (const service of seed.services) {
      await tx.insert(services).values({
        organisationId: org.id,
        venueId: venueRow.id,
        name: service.name,
        schedule: service.schedule,
        turnMinutes: service.turnMinutes,
      });
    }

    await tx.insert(outreachClaims).values({
      organisationId: org.id,
      tokenHash,
      prospectEmail: input.prospectEmail,
      prospectName: input.prospectName ?? null,
      expiresAt,
      createdByUserId: input.createdByUserId,
    });

    return { organisationId: org.id, venueId: venueRow.id };
  });

  // Sample bookings live in a separate transaction by design: they
  // need encrypted guest rows (which lazily provision the org's DEK),
  // and a seed-bookings failure shouldn't roll back the claimable
  // account itself — the prospect still gets a working dashboard,
  // just with an emptier diary. Log and continue.
  try {
    await seedSampleBookings({ organisationId, venueId, now });
  } catch (err) {
    console.error("createClaimableAccount: seedSampleBookings failed", err);
  }

  // Audit outside the txn so a logging failure doesn't roll back the
  // creation. Swallow + report rather than re-throw: the org is already
  // committed, and surfacing "audit write failed" to the UI would
  // mis-frame a successful create as failed. Sentry catches the
  // missing-audit case for ops follow-up.
  //
  // Metadata deliberately omits prospectEmail — audit_log rows live
  // 2 years per gdpr.md and the prospect never consented. Surface
  // the join via organisationId instead; the address is on
  // outreach_claims for as long as the org exists.
  try {
    await audit.log({
      organisationId,
      actorUserId: input.createdByUserId,
      action: "outreach.claimable_created",
      targetType: "organisation",
      targetId: organisationId,
      metadata: {
        placeId: input.place.id,
        venueType: seed.venue.venueType,
      },
    });
  } catch (err) {
    console.error("createClaimableAccount: audit.log failed", err);
  }

  return {
    organisationId,
    venueId,
    claimToken: token,
    claimUrl: buildClaimUrl({ token, appUrl: input.appUrl }),
    expiresAt,
  };
}
