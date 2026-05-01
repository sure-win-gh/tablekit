"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { importJobs } from "@/lib/db/schema";
import { processImportJob } from "@/lib/import/runner/writer";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

// Mapping schema. firstName + email are required at the form layer
// for a clearer operator error; lib/import/validate.ts:validateRow
// also enforces this row-by-row. Defence-in-depth — keep both.
// Marketing-consent is deliberately excluded — gdpr.md "consent
// never imports as granted."
const MappingSchema = z.object({
  firstName: z.string().min(1, "Map a column to first name."),
  email: z.string().min(1, "Map a column to email."),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
});

export type ConfirmState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "running" };

export async function confirmMapping(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const { orgId, userId } = await requireRole("manager");

  const jobIdRaw = formData.get("jobId");
  if (typeof jobIdRaw !== "string" || jobIdRaw.length === 0) {
    return { status: "error", message: "Missing job id." };
  }
  const jobId = jobIdRaw;

  const parsed = MappingSchema.safeParse({
    firstName: formData.get("firstName") ?? "",
    email: formData.get("email") ?? "",
    lastName: formData.get("lastName") ?? "",
    phone: formData.get("phone") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid mapping." };
  }

  // Drop optional empty strings so the column_map jsonb stays tidy.
  const columnMap: Record<string, string> = {
    firstName: parsed.data.firstName,
    email: parsed.data.email,
  };
  for (const k of ["lastName", "phone", "notes"] as const) {
    const v = parsed.data[k];
    if (v && v.length > 0) columnMap[k] = v;
  }

  const db = adminDb();

  // Atomic transition: only succeed if the row is still
  // `preview_ready`, belongs to the caller's org, and still has its
  // encrypted source CSV. The CSV check matters because a completed
  // re-run would otherwise be silently un-runnable (the runner nulls
  // source_csv_cipher on completion).
  const updated = await db
    .update(importJobs)
    .set({ status: "queued", columnMap })
    .where(
      and(
        eq(importJobs.id, jobId),
        eq(importJobs.organisationId, orgId),
        eq(importJobs.status, "preview_ready"),
      ),
    )
    .returning({ id: importJobs.id });
  if (updated.length === 0) {
    return {
      status: "error",
      message:
        "This job can no longer be queued. It may have already started, completed, or been removed.",
    };
  }

  // Audit metadata: only the destination field KEYS, never the
  // operator-supplied header strings. Headers can embed sample PII
  // (e.g. a column literally titled "Email Address — Jane") and
  // they're not constrained at all. The job id is the durable
  // handle for cross-referencing the actual mapping. See
  // gdpr.md "Things Claude Code must never do" entry on header
  // strings in audit payloads.
  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "import.queued",
    targetType: "import_job",
    targetId: jobId,
    metadata: { mappedFields: Object.keys(columnMap).sort() },
  });

  // Kick the runner inline so a small import shows results within
  // the same request. Long imports may exceed Vercel's function
  // timeout — the cron picks those up on the next nightly tick.
  // processImportJob is idempotent on terminal states. Wrap so a
  // throw doesn't surface to Next's error UI when the row is
  // already healthy in `queued`/`importing` and the cron will
  // recover. The runner itself catches and persists `failed` for
  // its own errors; this catch is for genuinely unexpected throws
  // (e.g. function timeout).
  try {
    await processImportJob(jobId);
  } catch {
    // Swallowed deliberately — see comment above.
  }

  revalidatePath(`/dashboard/data/import`);
  revalidatePath(`/dashboard/data/import/${jobId}`);
  return { status: "running" };
}
