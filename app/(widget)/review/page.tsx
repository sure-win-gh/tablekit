// Public review-submission page. Token in `?p=&s=` (HMAC-signed,
// matches the unsubscribe pattern). `mode=private` softens the framing
// for guests who chose the "send private feedback" link in the email
// — but the post-submit Google CTA still appears regardless of rating
// per Google's anti-gating policy.

import { eq } from "drizzle-orm";

import { bookings, venues } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";
import { verifyReviewToken } from "@/lib/messaging/review-tokens";

import { ReviewForm } from "./form";

export const metadata = {
  title: "Leave a review · TableKit",
  // Token URLs are personal to a guest — keep them out of search
  // engines.
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type SearchParams = { p?: string; s?: string; mode?: string };

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  if (!sp.p || !sp.s) return <BadLink />;

  const verified = verifyReviewToken(sp.p, sp.s);
  if (!verified.ok) {
    return <BadLink expired={verified.reason === "expired"} />;
  }

  const [row] = await adminDb()
    .select({ venueName: venues.name })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(eq(bookings.id, verified.payload.bookingId))
    .limit(1);
  if (!row) return <BadLink />;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-coral">
          {sp.mode === "private" ? "Private feedback" : "Leave a review"}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink">{row.venueName}</h1>
        <p className="mt-1 text-sm text-ash">
          {sp.mode === "private"
            ? "Thanks for taking a moment. The team will read this directly — it won't be shared."
            : "How was your visit? Takes 30 seconds — you can leave a comment too."}
        </p>
      </header>
      <ReviewForm p={sp.p} s={sp.s} mode={sp.mode === "private" ? "private" : "public"} />
      <p className="text-xs text-ash">
        Please don&apos;t include health information, allergies, or details about other people —
        the team only needs to know about your visit. We process this on behalf of {row.venueName}.{" "}
        <a href="/privacy" className="underline">
          How your data is handled
        </a>
        .
      </p>
    </main>
  );
}

function BadLink({ expired }: { expired?: boolean } = {}) {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center p-6">
      <div className="w-full rounded-md border border-neutral-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-neutral-900">
          {expired ? "Link expired" : "Link not recognised"}
        </h1>
        <p className="mt-2 text-sm text-neutral-600">
          {expired
            ? "This review link has expired. If you'd still like to share feedback, contact the venue directly."
            : "The review link looks invalid or has been edited. Please follow the link from the email again, or contact the venue directly."}
        </p>
      </div>
    </main>
  );
}
