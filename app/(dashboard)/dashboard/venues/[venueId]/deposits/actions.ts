"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { depositRules, venues, stripeAccounts } from "@/lib/db/schema";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

import type { ActionState } from "./types";

async function assertVenueInOrg(venueId: string, orgId: string): Promise<void> {
  const rows = await adminDb()
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (rows.length === 0) throw new Error("venue not found or not in your organisation");
}

// Rules CRUD is gated on the org having Connect fully enabled — we
// refuse to let operators author rules that will immediately fail on
// the widget because Stripe can't charge them.
async function assertChargesEnabled(orgId: string): Promise<void> {
  const [row] = await adminDb()
    .select({ chargesEnabled: stripeAccounts.chargesEnabled })
    .from(stripeAccounts)
    .where(eq(stripeAccounts.organisationId, orgId))
    .limit(1);
  if (!row || !row.chargesEnabled) {
    throw new Error("Connect Stripe first — deposits can't be taken until charges are enabled.");
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const KIND = ["per_cover", "flat", "card_hold"] as const;
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const CreateBody = z.object({
  venueId: z.uuid(),
  serviceId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  kind: z.enum(KIND),
  amountMinor: z.coerce.number().int().min(1).max(1_000_00), // up to £1,000
  minParty: z.coerce.number().int().min(1).max(50).default(1),
  maxParty: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? Number(v) : undefined))
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 50), {
      message: "Max party must be 1–50 or blank",
    }),
  refundWindowHours: z.coerce.number().int().min(0).max(168).default(24),
  dayOfWeek: z
    .array(z.coerce.number().int())
    .refine(
      (arr) => arr.length > 0 && arr.every((d) => DAYS.includes(d as (typeof DAYS)[number])),
      { message: "Pick at least one day" },
    ),
});

export async function createDepositRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = CreateBody.safeParse({
    venueId: formData.get("venue_id"),
    serviceId: formData.get("service_id") || undefined,
    kind: formData.get("kind"),
    amountMinor: formData.get("amount_minor"),
    minParty: formData.get("min_party") || "1",
    maxParty: formData.get("max_party"),
    refundWindowHours: formData.get("refund_window_hours") || "24",
    dayOfWeek: formData.getAll("day_of_week").map(String),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Check the rule fields.",
    };
  }
  if (parsed.data.maxParty !== undefined && parsed.data.maxParty < parsed.data.minParty) {
    return { status: "error", message: "Max party can't be less than min party." };
  }

  const { orgId, userId } = await requireRole("manager");
  await assertVenueInOrg(parsed.data.venueId, orgId);
  await assertChargesEnabled(orgId);

  const values: typeof depositRules.$inferInsert = {
    organisationId: orgId,
    venueId: parsed.data.venueId,
    kind: parsed.data.kind,
    amountMinor: parsed.data.amountMinor,
    minParty: parsed.data.minParty,
    dayOfWeek: parsed.data.dayOfWeek as number[],
    refundWindowHours: parsed.data.refundWindowHours,
  };
  if (parsed.data.serviceId) values.serviceId = parsed.data.serviceId;
  if (parsed.data.maxParty !== undefined) values.maxParty = parsed.data.maxParty;

  const [inserted] = await adminDb()
    .insert(depositRules)
    .values(values)
    .returning({ id: depositRules.id });

  if (inserted) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "deposit_rule.created",
      targetType: "deposit_rule",
      targetId: inserted.id,
      metadata: {
        venueId: parsed.data.venueId,
        kind: parsed.data.kind,
        amountMinor: parsed.data.amountMinor,
      },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/deposits`);
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const DeleteSchema = z.object({ ruleId: z.uuid(), venueId: z.uuid() });

export async function deleteDepositRule(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = DeleteSchema.safeParse({
    ruleId: formData.get("rule_id"),
    venueId: formData.get("venue_id"),
  });
  if (!parsed.success) return { status: "error", message: "Bad request." };

  const { orgId, userId } = await requireRole("manager");
  await assertVenueInOrg(parsed.data.venueId, orgId);

  const deleted = await adminDb()
    .delete(depositRules)
    .where(and(eq(depositRules.id, parsed.data.ruleId), eq(depositRules.organisationId, orgId)))
    .returning({ id: depositRules.id });

  if (deleted.length > 0) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "deposit_rule.deleted",
      targetType: "deposit_rule",
      targetId: parsed.data.ruleId,
      metadata: { venueId: parsed.data.venueId },
    });
  }

  revalidatePath(`/dashboard/venues/${parsed.data.venueId}/deposits`);
  return { status: "saved" };
}
