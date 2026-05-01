import { and, desc, eq } from "drizzle-orm";
import { ChevronRight, Lock, Upload } from "lucide-react";
import Link from "next/link";

import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { importJobs, users } from "@/lib/db/schema";

import { ImportUploadForm } from "./upload-form";

export const metadata = { title: "Import · TableKit" };

// Settings → Data → Import. PR4a ships the upload form and the
// list of past jobs. The mapping wizard + run trigger lands in
// PR4b — uploaded jobs persist in `preview_ready` until that PR
// adds the confirm-mapping action.

export default async function ImportPage() {
  const { orgId, role } = await requireRole("host");
  const canImport = role === "owner" || role === "manager";

  // Filter explicitly by orgId — RLS would scope to all the user's
  // orgs, but the page is org-scoped so we lean on the active-org
  // cookie. Same defence-in-depth as the export reader.
  const jobs = await withUser(async (db) =>
    db
      .select({
        id: importJobs.id,
        source: importJobs.source,
        status: importJobs.status,
        filename: importJobs.filename,
        rowCountTotal: importJobs.rowCountTotal,
        rowCountImported: importJobs.rowCountImported,
        rowCountRejected: importJobs.rowCountRejected,
        error: importJobs.error,
        createdAt: importJobs.createdAt,
        actorEmail: users.email,
      })
      .from(importJobs)
      .leftJoin(users, eq(users.id, importJobs.actorUserId))
      .where(and(eq(importJobs.organisationId, orgId)))
      .orderBy(desc(importJobs.createdAt))
      .limit(50),
  );

  return (
    <main className="flex flex-1 flex-col px-8 py-6">
      <nav className="text-ash flex items-center gap-1.5 text-xs">
        <Link href="/dashboard" className="hover:text-ink">
          Dashboard
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <Link href="/dashboard/data" className="hover:text-ink">
          Data
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink">Import</span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Upload className="text-coral h-6 w-6" aria-hidden />
          Import guests
        </h1>
        <p className="text-ash mt-1 text-sm">
          Upload a CSV to add guests in bulk. Marketing consent is never imported as granted —
          imported guests must opt in afresh. Each import is recorded in the audit log.
        </p>
      </header>

      {!canImport ? (
        <p className="rounded-card border-hairline bg-cloud text-ash mt-6 flex items-center gap-2 border p-4 text-sm">
          <Lock className="h-4 w-4" aria-hidden />
          Importing requires manager or owner role.
        </p>
      ) : (
        <section className="rounded-card border-hairline mt-6 border p-5">
          <h2 className="text-ink text-base font-semibold">New import</h2>
          <p className="text-ash mt-1 text-sm">
            Pick a CSV (up to 50MB). On the next page you&apos;ll match its columns to guest fields
            and run the import.
          </p>
          <ImportUploadForm />
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-ink text-base font-semibold">Recent imports</h2>
        {jobs.length === 0 ? (
          <p className="text-ash mt-3 text-sm">Nothing yet. Your first import will appear here.</p>
        ) : (
          <div className="border-hairline rounded-card mt-3 overflow-hidden border">
            <table className="w-full text-sm">
              <thead className="bg-cloud text-ash text-left text-xs tracking-wide uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Imported</th>
                  <th className="px-4 py-2 font-medium">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-hairline border-t">
                    <td className="text-ash px-4 py-2">
                      {j.createdAt.toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td
                      className="text-ink max-w-xs truncate px-4 py-2 font-medium"
                      title={j.filename}
                    >
                      <Link
                        href={`/dashboard/data/import/${j.id}`}
                        className="hover:text-coral underline-offset-2 hover:underline"
                      >
                        {j.filename}
                      </Link>
                    </td>
                    <td className="text-ash px-4 py-2">{j.source}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="text-ash px-4 py-2">
                      {j.rowCountImported}
                      {j.rowCountTotal !== null ? ` / ${j.rowCountTotal}` : ""}
                    </td>
                    <td className="text-ash px-4 py-2">{j.rowCountRejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Colour-by-state is a thin wrapper — the values come straight
  // from the import_jobs.status CHECK enum.
  const tone =
    status === "completed"
      ? "bg-green-50 text-green-700 ring-green-200"
      : status === "failed"
        ? "bg-red-50 text-red-700 ring-red-200"
        : status === "preview_ready"
          ? "bg-amber-50 text-amber-700 ring-amber-200"
          : "bg-cloud text-ash ring-stone-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {status === "preview_ready" ? "needs mapping" : status}
    </span>
  );
}
