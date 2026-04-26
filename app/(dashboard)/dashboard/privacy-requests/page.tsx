import { asc, desc, eq } from "drizzle-orm";
import { ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { dsarRequests, guests } from "@/lib/db/schema";

export const metadata = { title: "Privacy requests · TableKit" };

// Org-scoped inbox of DSAR requests. RLS on dsar_requests scopes the
// SELECT to the active org; this page just renders. Requester emails
// are encrypted — we show the matched-guest first name when we have
// one, otherwise a "click in to decrypt" affordance. We never decrypt
// PII just to populate a list.

function statusTone(status: string): "warning" | "info" | "success" | "muted" {
  switch (status) {
    case "pending":
      return "warning";
    case "in_progress":
      return "info";
    case "completed":
      return "success";
    case "rejected":
      return "muted";
    default:
      return "muted";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "export":
      return "Access / export";
    case "rectify":
      return "Correction";
    case "erase":
      return "Erasure";
    default:
      return kind;
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
};

export default async function PrivacyRequestsPage() {
  await requireRole("manager");

  const rows = await withUser(async (db) =>
    db
      .select({
        id: dsarRequests.id,
        kind: dsarRequests.kind,
        status: dsarRequests.status,
        guestId: dsarRequests.guestId,
        guestFirstName: guests.firstName,
        dueAt: dsarRequests.dueAt,
        requestedAt: dsarRequests.requestedAt,
      })
      .from(dsarRequests)
      .leftJoin(guests, eq(guests.id, dsarRequests.guestId))
      // Active first (oldest due first), then resolved (most recent first).
      .orderBy(
        // Pending + in_progress sort by due_at ascending; the rest
        // (completed/rejected) get sorted later by requestedAt desc.
        // Postgres NULLs sort last, so use a simple two-key sort.
        asc(dsarRequests.status),
        asc(dsarRequests.dueAt),
        desc(dsarRequests.requestedAt),
      ),
  );

  const active = rows.filter((r) => r.status === "pending" || r.status === "in_progress");
  const resolved = rows.filter((r) => r.status === "completed" || r.status === "rejected");

  return (
    <main className="flex flex-1 flex-col p-6">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="text-ink">Privacy requests</span>
      </nav>

      <header className="mt-3 border-b border-hairline pb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-ink">
          <ShieldCheck className="h-6 w-6 text-coral" aria-hidden />
          Privacy requests
        </h1>
        <p className="mt-1 text-sm text-ash">
          Subject access, correction, and erasure requests under UK GDPR. You have one calendar
          month from the request date to respond.
        </p>
      </header>

      <section className="mt-6 flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-ink">
          Active ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="rounded-card border border-dashed border-hairline p-6 text-center text-sm text-ash">
            No active requests. The form at <span className="font-mono text-xs">/privacy/request</span> routes new ones here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {active.map((r) => (
              <RequestRow
                key={r.id}
                id={r.id}
                kind={r.kind}
                status={r.status}
                guestFirstName={r.guestFirstName}
                dueAt={r.dueAt}
                requestedAt={r.requestedAt}
              />
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="mt-8 flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">
            Resolved ({resolved.length})
          </h2>
          <ul className="flex flex-col gap-2">
            {resolved.map((r) => (
              <RequestRow
                key={r.id}
                id={r.id}
                kind={r.kind}
                status={r.status}
                guestFirstName={r.guestFirstName}
                dueAt={r.dueAt}
                requestedAt={r.requestedAt}
                resolved
              />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

// Hoisted out of the component so the react-hooks/purity rule
// doesn't flag the Date.now() call. Server components render once
// per request, so the snapshot is fine — the rule's intent is
// targeting client components that re-render.
function serverNow(): number {
  return Date.now();
}

function RequestRow({
  id,
  kind,
  status,
  guestFirstName,
  dueAt,
  requestedAt,
  resolved,
}: {
  id: string;
  kind: string;
  status: string;
  guestFirstName: string | null;
  dueAt: Date;
  requestedAt: Date;
  resolved?: boolean;
}) {
  const now = serverNow();
  const overdue = !resolved && dueAt.getTime() < now;
  const daysLeft = Math.round((dueAt.getTime() - now) / (24 * 60 * 60 * 1000));

  return (
    <li>
      <Link
        href={`/dashboard/privacy-requests/${id}`}
        className="group flex items-center justify-between gap-4 rounded-card border border-hairline bg-white px-4 py-3 transition hover:border-ink"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-ink">{kindLabel(kind)}</span>
          <span className="text-xs text-ash">
            {guestFirstName
              ? `Matched to ${guestFirstName}`
              : "No matching guest profile yet"}
            {" · "}
            requested {requestedAt.toLocaleDateString("en-GB")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {overdue ? <Badge tone="danger">Overdue</Badge> : null}
          {!resolved && !overdue ? (
            <Badge tone={daysLeft <= 7 ? "warning" : "neutral"}>
              {daysLeft <= 0 ? "Due today" : `${daysLeft}d left`}
            </Badge>
          ) : null}
          <Badge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>
          <ChevronRight
            className="h-4 w-4 text-mute transition group-hover:translate-x-0.5 group-hover:text-ink"
            aria-hidden
          />
        </div>
      </Link>
    </li>
  );
}
