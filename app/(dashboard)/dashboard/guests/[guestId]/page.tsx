import { and, desc, eq } from "drizzle-orm";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { hasRole } from "@/lib/auth/role-level";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { bookings, guests, services, venues } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";

import { ConsentToggles, EditContactCard, EraseGuestButton } from "./forms";

export const metadata = { title: "Guest · TableKit" };
export const dynamic = "force-dynamic";

const VISIT_LIMIT = 50;

export default async function GuestProfilePage({
  params,
}: {
  params: Promise<{ guestId: string }>;
}) {
  const auth = await requireRole("host");
  const canEdit = hasRole(auth.role, "manager");
  const { guestId } = await params;

  const data = await withUser(async (db) => {
    const [guest] = await db
      .select({
        id: guests.id,
        firstName: guests.firstName,
        lastNameCipher: guests.lastNameCipher,
        emailCipher: guests.emailCipher,
        phoneCipher: guests.phoneCipher,
        marketingConsentEmailAt: guests.marketingConsentEmailAt,
        marketingConsentSmsAt: guests.marketingConsentSmsAt,
        marketingConsentAt: guests.marketingConsentAt,
        createdAt: guests.createdAt,
        erasedAt: guests.erasedAt,
        emailInvalid: guests.emailInvalid,
        phoneInvalid: guests.phoneInvalid,
      })
      .from(guests)
      .where(and(eq(guests.id, guestId), eq(guests.organisationId, auth.orgId)))
      .limit(1);
    if (!guest) return null;

    const visits = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        partySize: bookings.partySize,
        status: bookings.status,
        venueId: bookings.venueId,
        venueName: venues.name,
        venueTimezone: venues.timezone,
        serviceName: services.name,
      })
      .from(bookings)
      .innerJoin(venues, eq(venues.id, bookings.venueId))
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(eq(bookings.guestId, guest.id))
      .orderBy(desc(bookings.startAt))
      .limit(VISIT_LIMIT);

    return { guest, visits };
  });

  if (!data) notFound();
  const { guest, visits } = data;

  // Decrypt PII server-side under the withUser RLS context. We render
  // strings only — never ship cipher to the client.
  const lastName = guest.lastNameCipher
    ? await decryptPii(auth.orgId, guest.lastNameCipher as Ciphertext)
    : "";
  const email = await decryptPii(auth.orgId, guest.emailCipher as Ciphertext);
  const phone = guest.phoneCipher
    ? await decryptPii(auth.orgId, guest.phoneCipher as Ciphertext)
    : "";

  // Per-channel consent: prefer the new column. The legacy column
  // backstops a guest who consented before the per-channel migration
  // ran without a backfill.
  const emailConsentAt = guest.marketingConsentEmailAt ?? guest.marketingConsentAt;
  const smsConsentAt = guest.marketingConsentSmsAt;

  const fullName = lastName ? `${guest.firstName} ${lastName}` : guest.firstName;

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href="/dashboard/guests" className="hover:text-ink">
          Guests
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">{guest.firstName}</span>
      </nav>

      <header className="border-hairline mt-3 flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h1 className="text-ink text-2xl font-bold tracking-tight">{fullName}</h1>
          <p className="text-ash mt-1 text-sm">
            Member since {guest.createdAt.toLocaleDateString("en-GB")} ·{" "}
            {visits.length === 0
              ? "no visits yet"
              : `${visits.length} visit${visits.length === 1 ? "" : "s"}`}
          </p>
          {guest.erasedAt ? (
            <p className="text-rose mt-1 text-xs">
              Erased on {guest.erasedAt.toLocaleDateString("en-GB")} — DSAR scrub pending.
            </p>
          ) : null}
        </div>
        {canEdit && !guest.erasedAt ? <EraseGuestButton guestId={guest.id} /> : null}
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <EditContactCard
          guestId={guest.id}
          canEdit={canEdit}
          erased={Boolean(guest.erasedAt)}
          firstName={guest.firstName}
          lastName={lastName}
          email={email}
          phone={phone}
          emailInvalid={guest.emailInvalid}
          phoneInvalid={guest.phoneInvalid}
        />

        <ConsentToggles
          guestId={guest.id}
          erased={Boolean(guest.erasedAt)}
          emailConsentAt={emailConsentAt ? emailConsentAt.toISOString() : null}
          smsConsentAt={smsConsentAt ? smsConsentAt.toISOString() : null}
        />
      </section>

      <section className="mt-8">
        <h2 className="text-ash text-sm font-semibold tracking-wider uppercase">Visit history</h2>
        {visits.length === 0 ? (
          <p className="rounded-card border-hairline text-ash mt-3 border border-dashed p-6 text-center text-sm">
            No bookings yet for this guest.
          </p>
        ) : (
          <ul className="divide-hairline rounded-card border-hairline mt-3 divide-y border bg-white">
            {visits.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div className="flex flex-col">
                  <span className="text-ink font-mono tabular-nums">
                    {v.startAt.toLocaleString("en-GB", {
                      timeZone: v.venueTimezone,
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-ash text-xs">
                    {v.venueName} · {v.serviceName} · party of {v.partySize}
                  </span>
                </div>
                <Link
                  href={`/dashboard/venues/${v.venueId}/bookings?date=${v.startAt.toISOString().slice(0, 10)}`}
                  className="rounded-pill border-hairline text-ink hover:border-ink border px-2.5 py-0.5 text-xs font-medium"
                >
                  {v.status}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
