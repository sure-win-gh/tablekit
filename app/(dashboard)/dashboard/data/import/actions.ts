"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { MAX_SIZE_BYTES, createImportJob } from "@/lib/import/upload";
import { audit } from "@/lib/server/admin/audit";

const SOURCES = ["opentable", "resdiary", "sevenrooms", "generic-csv"] as const;

const SourceSchema = z.enum(SOURCES).default("generic-csv");

export type ActionState = { status: "idle" } | { status: "error"; message: string };

export async function uploadImport(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { orgId, userId } = await requireRole("manager");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Pick a CSV file to upload." };
  }
  if (file.size > MAX_SIZE_BYTES) {
    return {
      status: "error",
      message: `File is too large (max ${(MAX_SIZE_BYTES / 1_048_576).toFixed(0)}MB).`,
    };
  }

  const sourceParse = SourceSchema.safeParse(formData.get("source") ?? "generic-csv");
  if (!sourceParse.success) {
    return { status: "error", message: "Unknown source format." };
  }

  const csvText = await file.text();

  const result = await createImportJob({
    organisationId: orgId,
    actorUserId: userId,
    source: sourceParse.data,
    filename: file.name,
    csvText,
  });
  if (!result.ok) {
    const message = result.reason === "empty" ? "CSV is empty." : "CSV exceeds the 50MB cap.";
    return { status: "error", message };
  }

  // Audit metadata deliberately excludes `filename` — operator-
  // chosen filenames can embed guest PII (e.g. "guests-jane@…csv").
  // The job id is the durable handle; size is a rough indicator.
  // gdpr.md §"Things Claude Code must never do" pins this rule.
  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "import.uploaded",
    targetType: "import_job",
    targetId: result.jobId,
    metadata: { source: sourceParse.data, sizeBytes: file.size },
  });

  revalidatePath("/dashboard/data/import");
  return { status: "idle" };
}
