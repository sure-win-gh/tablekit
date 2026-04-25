// Per-venue unsubscribe page. Verifies the signed token from the
// email's List-Unsubscribe URL, applies the opt-out to the guest's
// emailUnsubscribedVenues / smsUnsubscribedVenues array.
//
// Tokens never expire by design — Gmail / Outlook re-process old
// emails for years and the unsubscribe link must keep working. The
// HMAC + the master-key rotation are the only mitigations against
// stale-link replay, and the action (add a venue uuid to an array)
// is idempotent so replay is harmless.

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

import { guests, venues } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { verifyUnsubscribe } from "@/lib/messaging/tokens";

export const metadata = { title: "Unsubscribe · TableKit" };
export const dynamic = "force-dynamic";

type SearchParams = { p?: string; s?: string };

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  if (!sp.p || !sp.s) return <Result kind="bad-link" />;

  const payload = verifyUnsubscribe(sp.p, sp.s);
  if (!payload) return <Result kind="bad-link" />;

  const db = adminDb();
  const [venue] = await db
    .select({ id: venues.id, name: venues.name })
    .from(venues)
    .where(eq(venues.id, payload.venueId))
    .limit(1);
  if (!venue) return <Result kind="bad-link" />;

  const [guest] = await db
    .select({ organisationId: guests.organisationId })
    .from(guests)
    .where(eq(guests.id, payload.guestId))
    .limit(1);
  if (!guest) return <Result kind="bad-link" />;

  // Append venue id to the appropriate array, idempotent — array_append
  // dedupes via array_position guard.
  const column =
    payload.channel === "email" ? guests.emailUnsubscribedVenues : guests.smsUnsubscribedVenues;
  await db
    .update(guests)
    .set({
      [payload.channel === "email" ? "emailUnsubscribedVenues" : "smsUnsubscribedVenues"]: sql`(
        case
          when ${payload.venueId}::uuid = any(${column}) then ${column}
          else array_append(${column}, ${payload.venueId}::uuid)
        end
      )`,
    })
    .where(eq(guests.id, payload.guestId));

  await audit.log({
    organisationId: guest.organisationId,
    actorUserId: null,
    action: "guest.unsubscribed",
    targetType: "guest",
    targetId: payload.guestId,
    metadata: { venueId: payload.venueId, channel: payload.channel },
  });

  return <Result kind="ok" venueName={venue.name} channel={payload.channel} />;
}

function Result({
  kind,
  venueName,
  channel,
}: {
  kind: "ok" | "bad-link";
  venueName?: string;
  channel?: "email" | "sms";
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center p-6">
      <div className="w-full rounded-md border border-neutral-200 bg-white p-6 text-center">
        {kind === "bad-link" ? (
          <>
            <h1 className="text-lg font-semibold text-neutral-900">Link not recognised</h1>
            <p className="mt-2 text-sm text-neutral-600">
              The unsubscribe link looks invalid or expired. If you keep getting messages, reply
              STOP to any SMS or contact the venue directly.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-neutral-900">Unsubscribed</h1>
            <p className="mt-2 text-sm text-neutral-600">
              You won&apos;t receive any more {channel === "email" ? "emails" : "SMS"} from{" "}
              {venueName}. Other venues you&apos;ve booked at are unaffected.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
