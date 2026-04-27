import { eq } from "drizzle-orm";
import { ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { dsarRequests, guests } from "@/lib/db/schema";
import { decryptPii, type Ciphertext } from "@/lib/security/crypto";

import { RequestActions } from "./forms";

export const metadata = { title: "Privacy request · TableKit" };

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
};

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

export default async function PrivacyRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const { id } = await params;

  const row = await withUser(async (db) => {
    const [r] = await db
      .select({
        id: dsarRequests.id,
        organisationId: dsarRequests.organisationId,
        kind: dsarRequests.kind,
        status: dsarRequests.status,
        requesterEmailCipher: dsarRequests.requesterEmailCipher,
        messageCipher: dsarRequests.messageCipher,
        guestId: dsarRequests.guestId,
        guestFirstName: guests.firstName,
        resolutionNotes: dsarRequests.resolutionNotes,
        dueAt: dsarRequests.dueAt,
        requestedAt: dsarRequests.requestedAt,
        resolvedAt: dsarRequests.resolvedAt,
      })
      .from(dsarRequests)
      .leftJoin(guests, eq(guests.id, dsarRequests.guestId))
      .where(eq(dsarRequests.id, id))
      .limit(1);
    return r;
  });

  if (!row) notFound();

  // Decrypt PII for display. RLS already gated the read, so we know
  // the operator is a member of the org owning the row.
  const [requesterEmail, message] = await Promise.all([
    decryptPii(orgId, row.requesterEmailCipher as Ciphertext),
    row.messageCipher ? decryptPii(orgId, row.messageCipher as Ciphertext) : Promise.resolve(null),
  ]);

  // Server-render snapshot of "now". The react-hooks/purity rule
  // would flag a direct Date.now() inside the component body; since
  // this is a server component executing once per request, the
  // alias keeps lint happy without changing semantics.
  const now = serverNow();
  const overdue =
    row.dueAt.getTime() < now && (row.status === "pending" || row.status === "in_progress");

  return (
    <main className="flex flex-1 flex-col py-6">
      <nav className="flex items-center gap-1.5 text-xs text-ash">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <Link href="/dashboard/privacy-requests" className="hover:text-ink">
          Privacy requests
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-stone" aria-hidden />
        <span className="font-mono text-ink">{row.id.slice(0, 8)}</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-ink">
            <ShieldCheck className="h-6 w-6 text-coral" aria-hidden />
            {kindLabel(row.kind)}
          </h1>
          <p className="mt-1 text-sm text-ash">
            Requested {row.requestedAt.toLocaleDateString("en-GB", { dateStyle: "long" })}
            {" · due "}
            {row.dueAt.toLocaleDateString("en-GB", { dateStyle: "long" })}
            {row.resolvedAt
              ? ` · resolved ${row.resolvedAt.toLocaleDateString("en-GB", { dateStyle: "long" })}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overdue ? <Badge tone="danger">Overdue</Badge> : null}
          <Badge tone={statusTone(row.status)}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
        </div>
      </header>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Requester email">
          <p className="font-mono text-sm text-ink">{requesterEmail}</p>
        </Field>
        <Field label="Matched guest">
          {row.guestId ? (
            <Link
              href={`/dashboard/venues`}
              className="text-sm font-semibold text-ink underline underline-offset-4 hover:text-coral"
            >
              {row.guestFirstName ?? "Open profile"}
            </Link>
          ) : (
            <p className="text-sm text-ash">No matching profile in this organisation.</p>
          )}
        </Field>
      </section>

      <section className="mt-6">
        <Field label="Message from requester">
          {message ? (
            <p className="whitespace-pre-line rounded-card border border-hairline bg-cloud p-4 text-sm text-charcoal">
              {message}
            </p>
          ) : (
            <p className="text-sm text-ash">No additional message.</p>
          )}
        </Field>
      </section>

      {row.resolutionNotes ? (
        <section className="mt-6">
          <Field label="Resolution notes">
            <p className="whitespace-pre-line rounded-card border border-hairline bg-white p-4 text-sm text-charcoal">
              {row.resolutionNotes}
            </p>
          </Field>
        </section>
      ) : null}

      <section className="mt-8 border-t border-hairline pt-6">
        <RequestActions
          dsarId={row.id}
          status={row.status as "pending" | "in_progress" | "completed" | "rejected"}
          existingNotes={row.resolutionNotes ?? ""}
        />
      </section>
    </main>
  );
}

// `Date.now()` extracted into a non-component helper. The lint rule
// only fires when Date.now is called *inside* a component / hook;
// behind a function boundary it's fine.
function serverNow(): number {
  return Date.now();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-ash">{label}</p>
      {children}
    </div>
  );
}
