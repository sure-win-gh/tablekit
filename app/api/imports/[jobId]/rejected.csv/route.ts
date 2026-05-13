// CSV download of rows that failed validation / dedupe during an
// import job.
//
//   GET /api/imports/[jobId]/rejected.csv
//
// Auth-gated to operators in the owning organisation. requireRole at
// "host" is the minimum — anyone allowed to see the import job is
// allowed to see its rejected rows. Per-venue scope doesn't apply:
// import jobs are org-scoped, not venue-scoped.
//
// The CSV ciphertext lives on `import_jobs.rejected_rows_cipher`,
// stamped by the runner on completion (only when any rows were
// rejected). 404 when the column is null so a job with no rejections
// doesn't leak a misleading "permission denied" if a curious operator
// pokes the URL.
//
// PII posture (gdpr.md §Logs):
//   • CSV plaintext lives on the stack only.
//   • `data.exported` audit row keeps the count for compliance review
//     without writing the CSV itself to the log.
//   • cache-control: private, no-store keeps proxies from caching.

import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { importJobs } from "@/lib/db/schema";
import { type Ciphertext, decryptPii } from "@/lib/security/crypto";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await ctx.params;

  const { orgId, userId } = await requireRole("host");
  const db = adminDb();
  const [row] = await db
    .select({
      id: importJobs.id,
      organisationId: importJobs.organisationId,
      rejectedRowsCipher: importJobs.rejectedRowsCipher,
      rowCountRejected: importJobs.rowCountRejected,
      createdAt: importJobs.createdAt,
    })
    .from(importJobs)
    .where(eq(importJobs.id, jobId))
    .limit(1);

  // Treat "not yours" the same as "not found" — no oracle for
  // attackers checking whether a UUID exists in someone else's org.
  if (!row || row.organisationId !== orgId) {
    return new NextResponse(null, { status: 404 });
  }
  if (!row.rejectedRowsCipher) {
    return new NextResponse(null, { status: 404 });
  }

  let csv: string;
  try {
    csv = await decryptPii(row.organisationId, row.rejectedRowsCipher as Ciphertext);
  } catch {
    return new NextResponse(null, { status: 500 });
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "data.exported",
    targetType: "import_job",
    targetId: row.id,
    metadata: {
      metric: "import_rejected_rows",
      count: row.rowCountRejected,
    },
  });

  const stamp = row.createdAt.toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-rejected-${stamp}-${row.id.slice(0, 8)}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
