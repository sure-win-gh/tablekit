"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { enqueueCampaign } from "@/lib/campaigns/enqueue";
import { processNextCampaignBatch } from "@/lib/campaigns/dispatch";
import { findUnknownMarketingTags, renderCampaign } from "@/lib/campaigns/render";
import { campaigns, venues } from "@/lib/db/schema";
import { parseBranding } from "@/lib/messaging/venue-settings";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

const CHANNEL = z.enum(["email", "sms", "whatsapp"]);

export type CreateCampaignState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; campaignId: string; queued: number; sent: boolean };

// Create a campaign and optionally send it now. Plus-tier gated.
export async function createCampaign(
  _prev: CreateCampaignState,
  fd: FormData,
): Promise<CreateCampaignState> {
  const { orgId, userId } = await requireRole("manager");
  try {
    await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof InsufficientPlanError) {
      return { status: "error", message: "Marketing campaigns are a Plus-tier feature." };
    }
    throw err;
  }

  const parsed = z
    .object({
      venueId: z.uuid(),
      name: z.string().min(1).max(120),
      channel: CHANNEL,
      subject: z.string().max(200).optional(),
      body: z.string().min(1, "Write some copy").max(2000),
      send: z.boolean(),
    })
    .safeParse({
      venueId: fd.get("venue_id"),
      name: fd.get("name"),
      channel: fd.get("channel"),
      subject: (fd.get("subject") as string | null) ?? undefined,
      body: fd.get("body"),
      send: fd.get("send") === "now",
    });
  if (!parsed.success) {
    return { status: "error", message: "Please complete the campaign fields." };
  }

  const { venueId, name, channel } = parsed.data;
  const body = parsed.data.body.trim();
  const subject = parsed.data.subject?.trim() ?? "";

  // Optional schedule (datetime-local string). When set on a send, the
  // campaign fans out now but each send sits dormant (next_attempt_at =
  // scheduleAt) until the campaign-tick cron drains it — no extra cron
  // scan needed since the worker already filters next_attempt_at <= now.
  const now = new Date();
  let scheduleAt: Date | undefined;
  const scheduleRaw = (fd.get("schedule_at") as string | null)?.trim();
  if (parsed.data.send && scheduleRaw) {
    const d = new Date(scheduleRaw);
    if (Number.isNaN(d.getTime())) {
      return { status: "error", message: "Invalid schedule date." };
    }
    if (d.getTime() <= now.getTime()) {
      return { status: "error", message: "Schedule must be in the future." };
    }
    scheduleAt = d;
  }

  const db = adminDb();
  // Org guard — adminDb bypasses RLS, so this check carries it.
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { status: "error", message: "Venue not found or not in your organisation." };

  const [campaign] = await db
    .insert(campaigns)
    .values({
      organisationId: orgId, // overwritten by enforce trigger from the venue
      venueId,
      name,
      channel,
      status: "draft",
      subjectOverride: channel === "email" ? subject || null : null,
      body,
      createdByUserId: userId,
    })
    .returning({ id: campaigns.id });
  if (!campaign) return { status: "error", message: "Could not create the campaign." };

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "campaign.created",
    targetType: "campaign",
    targetId: campaign.id,
    metadata: { channel, name },
  });

  if (!parsed.data.send) {
    revalidatePath(`/dashboard/venues/${venueId}/campaigns`);
    return { status: "created", campaignId: campaign.id, queued: 0, sent: false };
  }

  // Fan out. Scheduled: sends sit dormant until scheduleAt (cron drains).
  // Send-now: drive the worker inline so the first batch lands immediately.
  const r = await enqueueCampaign(campaign.id, scheduleAt ? { now, scheduleAt } : { now });
  if (r.ok && !scheduleAt) {
    await processNextCampaignBatch({ limit: 50, now }).catch(() => undefined);
  }
  revalidatePath(`/dashboard/venues/${venueId}/campaigns`);
  return {
    status: "created",
    campaignId: campaign.id,
    queued: r.ok ? r.queued : 0,
    sent: true,
  };
}

// Live preview of campaign copy against a sample guest. Plus-gated.
export type CampaignPreview =
  | { ok: true; kind: "email"; subject: string; html: string; unknownTags: string[] }
  | { ok: true; kind: "sms" | "whatsapp"; body: string; unknownTags: string[] }
  | { ok: false; message: string };

export async function previewCampaign(input: {
  venueId: string;
  channel: string;
  subject?: string;
  body?: string;
}): Promise<CampaignPreview> {
  const { orgId } = await requireRole("manager");
  try {
    await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof InsufficientPlanError) return { ok: false, message: "Plus-tier feature." };
    throw err;
  }
  const channel = CHANNEL.safeParse(input.channel);
  const vid = z.uuid().safeParse(input.venueId);
  if (!channel.success || !vid.success) return { ok: false, message: "Invalid selection." };

  const db = adminDb();
  const [venue] = await db
    .select({ name: venues.name, settings: venues.settings })
    .from(venues)
    .where(and(eq(venues.id, vid.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false, message: "Venue not found." };

  const body = (input.body ?? "").slice(0, 2000);
  const subject = (input.subject ?? "").slice(0, 200);
  const unknownTags = [...findUnknownMarketingTags(body), ...findUnknownMarketingTags(subject)];

  const rendered = await renderCampaign({
    channel: channel.data,
    subject: subject || null,
    body: body || "(your message)",
    ctx: {
      guestFirstName: "Jamie",
      venueName: venue.name,
      unsubscribeUrl: "https://app.tablekit.uk/unsubscribe?p=sample",
      branding: parseBranding(venue.settings),
    },
  });

  if (rendered.kind === "email") {
    return {
      ok: true,
      kind: "email",
      subject: rendered.rendered.subject,
      html: rendered.rendered.html,
      unknownTags,
    };
  }
  return { ok: true, kind: rendered.kind, body: rendered.rendered.body, unknownTags };
}
