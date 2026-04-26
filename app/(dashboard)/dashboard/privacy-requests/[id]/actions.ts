"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { transitionDsarRequest, type DsarStatus } from "@/lib/dsar/transition";

const Form = z.object({
  dsarId: z.string().uuid(),
  to: z.enum(["in_progress", "completed", "rejected"]),
  resolutionNotes: z.string().max(2000).optional(),
});

export type ActOnDsarState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; from: DsarStatus; to: DsarStatus };

export async function actOnDsar(
  _prev: ActOnDsarState,
  formData: FormData,
): Promise<ActOnDsarState> {
  const { orgId, userId } = await requireRole("manager");

  const parsed = Form.safeParse({
    dsarId: formData.get("dsarId"),
    to: formData.get("to"),
    resolutionNotes: formData.get("resolutionNotes") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Couldn't read the form." };
  }

  const r = await transitionDsarRequest({
    organisationId: orgId,
    actorUserId: userId,
    dsarId: parsed.data.dsarId,
    to: parsed.data.to,
    ...(parsed.data.resolutionNotes !== undefined
      ? { resolutionNotes: parsed.data.resolutionNotes }
      : {}),
  });

  if (!r.ok) {
    const message =
      r.reason === "not-found"
        ? "Request not found."
        : r.reason === "wrong-org"
          ? "Request not found."
          : `Cannot move from ${r.from} to ${parsed.data.to}.`;
    return { status: "error", message };
  }

  revalidatePath(`/dashboard/privacy-requests/${parsed.data.dsarId}`);
  revalidatePath(`/dashboard/privacy-requests`);
  return { status: "done", from: r.from, to: r.to };
}
