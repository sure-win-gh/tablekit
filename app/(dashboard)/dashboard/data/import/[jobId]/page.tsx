import { and, eq } from "drizzle-orm";
import { ChevronRight, Lock } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireRole } from "@/lib/auth/require-role";
import { importJobs } from "@/lib/db/schema";
import { parseCsv } from "@/lib/import/parse";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";
import { adminDb } from "@/lib/server/admin/db";

import { MappingForm } from "./forms";

export const metadata = { title: "Import job · TableKit" };

// PR4b: detail page. For preview_ready jobs we decrypt the source
// CSV, parse the headers + first 10 rows, and present the column-
// mapping form. For terminal jobs we show a summary. Decryption
// happens on the server only — the plaintext never crosses to the
// client.

const PREVIEW_ROWS = 10;

export default async function ImportDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { orgId, role } = await requireRole("host");
  const canImport = role === "owner" || role === "manager";

  // adminDb to bypass RLS — but we MUST scope by orgId here because
  // we're skipping RLS deliberately. Defence-in-depth: the FK +
  // explicit org filter together cover the case where a stale jobId
  // is shared across orgs.
  const [job] = await adminDb()
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, jobId), eq(importJobs.organisationId, orgId)))
    .limit(1);
  if (!job) notFound();

  // For preview_ready jobs only, decrypt + parse so the operator
  // can confirm the column mapping. Terminal jobs display a summary
  // instead. The CSV is nulled on `completed`, so a completed job
  // can't be re-previewed.
  let preview: { headers: string[]; rows: Array<Record<string, string>> } | null = null;
  if (job.status === "preview_ready" && job.sourceCsvCipher) {
    const csvText = await decryptPii(orgId, job.sourceCsvCipher as Ciphertext);
    const parsed = parseCsv(csvText);
    preview = { headers: parsed.headers, rows: parsed.rows.slice(0, PREVIEW_ROWS) };
  }

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
        <Link href="/dashboard/data/import" className="hover:text-ink">
          Import
        </Link>
        <ChevronRight className="text-stone h-3.5 w-3.5" aria-hidden />
        <span className="text-ink truncate" title={job.filename}>
          {job.filename}
        </span>
      </nav>

      <header className="border-hairline mt-3 border-b pb-4">
        <h1 className="text-ink text-2xl font-bold tracking-tight">{job.filename}</h1>
        <p className="text-ash mt-1 text-sm">
          Source: <span className="text-ink">{job.source}</span> · Status:{" "}
          <span className="text-ink">
            {job.status === "preview_ready" ? "needs mapping" : job.status}
          </span>
        </p>
      </header>

      {job.status === "preview_ready" && preview ? (
        canImport ? (
          <PreviewSection
            jobId={job.id}
            headers={preview.headers}
            rows={preview.rows}
            totalRowsHint={null}
          />
        ) : (
          <p className="rounded-card border-hairline bg-cloud text-ash mt-6 flex items-center gap-2 border p-4 text-sm">
            <Lock className="h-4 w-4" aria-hidden />
            Confirming the import requires manager or owner role.
          </p>
        )
      ) : null}

      {job.status === "queued" || job.status === "importing" ? (
        <p className="rounded-card border-hairline bg-cloud text-ink mt-6 border p-4 text-sm">
          Import is running. Refresh in a moment to see progress.
        </p>
      ) : null}

      {job.status === "completed" ? <SummarySection job={job} /> : null}

      {job.status === "failed" ? (
        <div className="rounded-card mt-6 border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-medium text-red-700">Import failed.</p>
          {job.error ? <p className="mt-1 font-mono text-xs text-red-700">{job.error}</p> : null}
        </div>
      ) : null}
    </main>
  );
}

function PreviewSection({
  jobId,
  headers,
  rows,
}: {
  jobId: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  totalRowsHint: number | null;
}) {
  return (
    <>
      <section className="mt-6">
        <h2 className="text-ink text-base font-semibold">Preview ({rows.length} rows)</h2>
        <p className="text-ash mt-1 text-sm">
          First {rows.length} rows of your CSV. Match each column to a guest field below.
        </p>
        <div className="border-hairline rounded-card mt-3 overflow-x-auto border">
          <table className="w-full text-sm">
            <thead className="bg-cloud text-ash text-left text-xs tracking-wide uppercase">
              <tr>
                {headers.map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-hairline border-t">
                  {headers.map((h) => (
                    <td key={h} className="text-ink truncate px-3 py-2" title={r[h] ?? ""}>
                      {r[h] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-ink text-base font-semibold">Column mapping</h2>
        <p className="text-ash mt-1 text-sm">
          Match each guest field to one of your CSV columns. First name and email are required —
          rows missing either go into the rejected report. Marketing consent isn&apos;t mapped here:
          imported guests must opt in afresh.
        </p>
        <MappingForm jobId={jobId} headers={headers} />
      </section>
    </>
  );
}

function SummarySection({ job }: { job: typeof importJobs.$inferSelect }) {
  return (
    <section className="mt-6">
      <h2 className="text-ink text-base font-semibold">Summary</h2>
      <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Imported" value={job.rowCountImported} />
        <Stat label="Rejected" value={job.rowCountRejected} />
        <Stat label="Total rows" value={job.rowCountTotal ?? 0} />
        <Stat
          label="Completed"
          value={
            job.completedAt
              ? job.completedAt.toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"
          }
        />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-card border-hairline border p-3">
      <dt className="text-ash text-xs tracking-wide uppercase">{label}</dt>
      <dd className="text-ink mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}
