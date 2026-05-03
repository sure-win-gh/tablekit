import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { assertVenueVisible } from "@/lib/auth/venue-scope";
import { withUser } from "@/lib/db/client";
import { type InboxBucket, loadInboxList } from "@/lib/enquiries/inbox";

export const metadata = { title: "Enquiries · TableKit" };
export const dynamic = "force-dynamic";

const BUCKETS: ReadonlyArray<{ id: InboxBucket; label: string }> = [
  { id: "needs_action", label: "Needs action" },
  { id: "replied", label: "Replied" },
  { id: "discarded", label: "Discarded" },
];

export default async function EnquiriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ venueId: string }>;
  searchParams: Promise<{ bucket?: string }>;
}) {
  const { orgId } = await requireRole("host");
  await requirePlan(orgId, "plus");

  const { venueId } = await params;
  if (!(await assertVenueVisible(venueId))) notFound();

  const sp = await searchParams;
  const bucket: InboxBucket =
    sp.bucket === "replied" || sp.bucket === "discarded" ? sp.bucket : "needs_action";

  const rows = await withUser((db) => loadInboxList(db, { venueId, bucket }));

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-lg font-medium tracking-tight">Enquiries</h2>
        <p className="text-ash text-sm">
          Inbound emails forwarded to this venue. Drafts are AI-generated; you review and send.
        </p>
      </div>

      <nav className="border-hairline flex gap-1 border-b text-sm">
        {BUCKETS.map((b) => {
          const active = b.id === bucket;
          return (
            <Link
              key={b.id}
              href={`?bucket=${b.id}`}
              className={
                active
                  ? "text-ink border-ink -mb-px border-b-2 px-3 py-2 font-medium"
                  : "text-ash hover:text-ink -mb-px border-b-2 border-transparent px-3 py-2"
              }
            >
              {b.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <p className="border-hairline text-ash rounded-md border border-dashed p-4 text-sm">
          {bucket === "needs_action"
            ? "Nothing waiting. New enquiries will land here."
            : bucket === "replied"
              ? "No replies sent yet."
              : "No discarded enquiries."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/dashboard/venues/${venueId}/enquiries/${r.id}`}
                className="rounded-card border-hairline hover:border-ink block border bg-white px-4 py-3 transition"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-1 flex-col">
                    <div className="flex items-center gap-2">
                      <span className="text-ink truncate text-sm font-semibold">{r.subject}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <span className="text-ash text-xs">
                      {r.preview} · {r.receivedAt.toLocaleDateString("en-GB")}
                    </span>
                  </div>
                  <ChevronRight className="text-stone h-4 w-4" aria-hidden />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    received: "bg-stone-100 text-stone-700",
    parsing: "bg-amber-100 text-amber-800",
    draft_ready: "bg-emerald-100 text-emerald-800",
    replied: "bg-stone-100 text-stone-700",
    failed: "bg-red-100 text-red-800",
    discarded: "bg-stone-100 text-stone-500",
  };
  const label: Record<string, string> = {
    received: "Queued",
    parsing: "Parsing",
    draft_ready: "Draft ready",
    replied: "Replied",
    failed: "Failed",
    discarded: "Discarded",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-stone-100 text-stone-700"}`}
    >
      {label[status] ?? status}
    </span>
  );
}
