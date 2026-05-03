import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { withUser } from "@/lib/db/client";
import { type EnquiryDetail, loadEnquiryForOperator } from "@/lib/enquiries/inbox";

import { DismissButton, ResetOrphanButton, RetryFailedButton, SendDraftForm } from "./forms";

export const metadata = { title: "Enquiry · TableKit" };
export const dynamic = "force-dynamic";

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ venueId: string; enquiryId: string }>;
}) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { venueId, enquiryId } = await params;
  if (!(await assertVenueVisible(venueId))) notFound();

  const enquiry = await withUser((db) => loadEnquiryForOperator(db, { enquiryId, venueId }));
  if (!enquiry) notFound();

  const subjectGuess = enquiry.subject.startsWith("Re:")
    ? enquiry.subject
    : `Re: ${enquiry.subject}`;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href={`/dashboard/venues/${venueId}/enquiries`}
            className="text-ash hover:text-ink text-xs"
          >
            ← Inbox
          </Link>
          <h2 className="text-ink mt-1 text-lg font-medium tracking-tight">{enquiry.subject}</h2>
          <p className="text-ash text-xs">
            From {enquiry.fromEmail} · {enquiry.receivedAt.toLocaleString("en-GB")}
          </p>
        </div>
      </div>

      <ParsedSummary enquiry={enquiry} />

      <details className="border-hairline rounded-card border bg-white">
        <summary className="text-ash hover:text-ink cursor-pointer px-4 py-3 text-sm">
          Show original email
        </summary>
        <pre className="text-ash border-hairline border-t px-4 py-3 text-xs break-words whitespace-pre-wrap">
          {enquiry.body}
        </pre>
      </details>

      {enquiry.suggestedSlots.length > 0 ? (
        <div className="rounded-card border-hairline border bg-white p-4">
          <h3 className="text-ink mb-2 text-sm font-medium">Suggested slots</h3>
          <ul className="text-ash flex flex-col gap-1 text-sm">
            {enquiry.suggestedSlots.map((s, i) => (
              <li key={i}>
                {s.serviceName} · {s.wallStart}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ActionPanel enquiry={enquiry} venueId={venueId} subjectGuess={subjectGuess} />
    </section>
  );
}

function ParsedSummary({ enquiry }: { enquiry: EnquiryDetail }) {
  if (!enquiry.parsed) {
    return (
      <div className="rounded-card border-hairline text-ash border bg-white p-4 text-sm">
        Awaiting parse.
      </div>
    );
  }
  if (enquiry.parsed.kind === "not_a_booking_request") {
    return (
      <div className="rounded-card border border-amber-200 bg-amber-50 p-4 text-sm">
        <strong className="text-amber-900">Not a booking request</strong>
        <p className="text-amber-800">
          The parser didn&apos;t identify this as a booking enquiry. Review and dismiss, or reply
          manually if needed.
        </p>
      </div>
    );
  }

  const p = enquiry.parsed;
  const underspecified = !p.partySize || !p.requestedDate;

  return (
    <div className="rounded-card border-hairline border bg-white p-4">
      <h3 className="text-ink mb-2 text-sm font-medium">What we parsed</h3>
      <dl className="text-ash grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-ash text-xs">Guest</dt>
        <dd>{[p.guestFirstName, p.guestLastName].filter(Boolean).join(" ") || "—"}</dd>
        <dt className="text-ash text-xs">Party size</dt>
        <dd>{p.partySize ?? "—"}</dd>
        <dt className="text-ash text-xs">Date</dt>
        <dd>{p.requestedDate ?? "—"}</dd>
        <dt className="text-ash text-xs">Time</dt>
        <dd>{p.requestedTimeWindow ?? "—"}</dd>
        {p.specialRequests.length > 0 ? (
          <>
            <dt className="text-ash text-xs">Notes</dt>
            <dd>{p.specialRequests.join("; ")}</dd>
          </>
        ) : null}
      </dl>
      {underspecified ? (
        <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Some details are missing. Consider replying to ask the guest for clarification before
          confirming a slot.
        </p>
      ) : null}
    </div>
  );
}

function ActionPanel({
  enquiry,
  venueId,
  subjectGuess,
}: {
  enquiry: EnquiryDetail;
  venueId: string;
  subjectGuess: string;
}) {
  switch (enquiry.status) {
    case "draft_ready":
      return (
        <div className="rounded-card border-hairline border bg-white p-4">
          <h3 className="text-ink mb-3 text-sm font-medium">Reply</h3>
          <SendDraftForm
            venueId={venueId}
            enquiryId={enquiry.id}
            initialSubject={subjectGuess}
            initialBody={enquiry.draftReply ?? ""}
          />
        </div>
      );
    case "received":
      return (
        <div className="rounded-card border-hairline border bg-white p-4 text-sm">
          <p className="text-ash mb-3">Queued for parsing. The cron will pick it up shortly.</p>
          <DismissButton venueId={venueId} enquiryId={enquiry.id} />
        </div>
      );
    case "parsing":
      return (
        <div className="rounded-card border-hairline border bg-white p-4 text-sm">
          <p className="text-ash mb-3">Currently parsing.</p>
          <ResetOrphanButton venueId={venueId} enquiryId={enquiry.id} />
        </div>
      );
    case "failed":
      return (
        <div className="rounded-card border border-red-200 bg-red-50 p-4 text-sm">
          <p className="mb-2 text-red-900">
            <strong>Parse failed</strong>
            {enquiry.error ? ` — ${enquiry.error}` : ""}
          </p>
          <p className="text-ash mb-3 text-xs">
            Retry the parse or dismiss the enquiry. {enquiry.parseAttempts} attempt(s) so far.
          </p>
          <div className="flex gap-2">
            <RetryFailedButton venueId={venueId} enquiryId={enquiry.id} />
            <DismissButton venueId={venueId} enquiryId={enquiry.id} />
          </div>
        </div>
      );
    case "replied":
      return (
        <div className="rounded-card border-hairline border bg-white p-4 text-sm">
          <p className="text-ash">
            Replied {enquiry.repliedAt ? `on ${enquiry.repliedAt.toLocaleString("en-GB")}` : ""}.
          </p>
          {enquiry.draftReply ? (
            <pre className="text-ash border-hairline mt-3 border-t pt-3 text-xs break-words whitespace-pre-wrap">
              {enquiry.draftReply}
            </pre>
          ) : null}
        </div>
      );
    case "discarded":
      return (
        <div className="rounded-card border-hairline border bg-white p-4 text-sm">
          <p className="text-ash">Discarded.</p>
        </div>
      );
    default:
      return null;
  }
}
