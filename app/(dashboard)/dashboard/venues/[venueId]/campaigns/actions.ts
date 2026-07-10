"use server";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { getPlan, InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
import { getBalance } from "@/lib/billing/credit";
import { getEmailAllowanceState, isEmailOverageEnforced } from "@/lib/billing/email-allowance";
import {
  MARKETING_EMAIL,
  emailCampaignCostPence,
  emailChargeableCount,
} from "@/lib/billing/marketing-email";
import {
  campaignAssetPublicUrl,
  campaignImageExtensionForMime,
  MAX_CAMPAIGN_IMAGE_BYTES,
} from "@/lib/campaigns/assets";
import {
  docTemplateStrings,
  docToPlainText,
  parseBodyDoc,
  type CampaignBodyDoc,
} from "@/lib/campaigns/blocks";
import { combineHtml, htmlToPlainText, sanitizeCampaignHtml } from "@/lib/campaigns/html-import";
import { enqueueCampaign } from "@/lib/campaigns/enqueue";
import { processNextCampaignBatch } from "@/lib/campaigns/dispatch";
import { estimateAudience } from "@/lib/campaigns/recipients";
import { findUnknownMarketingTags, renderCampaign } from "@/lib/campaigns/render";
import { withUser } from "@/lib/db/client";
import { campaigns, campaignTemplates, users, venues } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/send";
import { SEGMENTS } from "@/lib/guests/segments";
import { parseBranding } from "@/lib/messaging/venue-settings";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { uploadCampaignAssetObject } from "@/lib/server/admin/storage";

const CHANNEL = z.enum(["email", "sms", "whatsapp"]);
const SEGMENT = z.enum(SEGMENTS);

// Per-channel plan gate (docs/specs/email-broadcast-billing.md): email
// broadcasts are Core+; SMS/WhatsApp broadcasts and audience segments
// stay Plus. Returns a user-facing error message, or null when allowed.
async function checkCampaignPlan(
  orgId: string,
  channel: z.infer<typeof CHANNEL>,
  segment: z.infer<typeof SEGMENT>,
): Promise<string | null> {
  try {
    await requirePlan(orgId, "core");
    if (channel !== "email") await requirePlan(orgId, "plus");
    else if (segment !== "all") await requirePlan(orgId, "plus");
  } catch (err) {
    if (err instanceof InsufficientPlanError) {
      if (channel !== "email") return "SMS and WhatsApp broadcasts are a Plus-tier feature.";
      if (segment !== "all") return "Audience segments are a Plus-tier feature.";
      return "Email campaigns are available on Core and Plus plans.";
    }
    throw err;
  }
  return null;
}

// Booking-page + app origins for the bookingCta/countdown blocks in
// previews and test sends (real sends build these in the dispatch worker).
function campaignSurfaceCtx(slug: string | null, venueId: string) {
  const widgetOrigin = (process.env["NEXT_PUBLIC_WIDGET_URL"] ?? "").replace(/\/$/, "");
  return {
    bookingUrl: widgetOrigin ? `${widgetOrigin}/book/${slug ?? venueId}` : undefined,
    appUrl: process.env["NEXT_PUBLIC_APP_URL"] ?? "https://app.tablekit.test",
  };
}

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

  // Block-doc body (email builder). Parsed BEFORE the flat-field zod pass
  // so the plain-text projection can stand in for `body`. Untrusted JSON —
  // full boundary validation in lib/campaigns/blocks.ts.
  let bodyDoc: CampaignBodyDoc | null = null;
  const bodyDocRaw = ((fd.get("body_doc") as string | null) ?? "").trim();
  if (bodyDocRaw) {
    if (fd.get("channel") !== "email") {
      return { status: "error", message: "Email designs can only be sent on the email channel." };
    }
    let json: unknown;
    try {
      json = JSON.parse(bodyDocRaw);
    } catch {
      return { status: "error", message: "Invalid email design." };
    }
    const r = parseBodyDoc(json);
    if (!r.ok) return { status: "error", message: `Invalid email design — ${r.error}` };
    bodyDoc = r.doc;
  }

  // Custom-HTML body (docs/specs/custom-email-html.md): sanitised HERE and
  // stored only in its clean form; re-sanitised again at send.
  let htmlBody: string | null = null;
  const htmlRaw = ((fd.get("html_body") as string | null) ?? "").trim();
  if (htmlRaw) {
    if (fd.get("channel") !== "email") {
      return { status: "error", message: "Custom HTML can only be sent on the email channel." };
    }
    if (bodyDoc) {
      return { status: "error", message: "A campaign can't be both a design and custom HTML." };
    }
    const r = sanitizeCampaignHtml(htmlRaw);
    if (!r.ok) return { status: "error", message: r.error };
    htmlBody = combineHtml(r); // markup + sanitised responsive CSS together
  }

  const parsed = z
    .object({
      venueId: z.uuid(),
      name: z.string().min(1).max(120),
      channel: CHANNEL,
      segment: SEGMENT,
      subject: z.string().max(200).optional(),
      body: z.string().min(1, "Write some copy").max(2000),
      send: z.boolean(),
    })
    .safeParse({
      venueId: fd.get("venue_id"),
      name: fd.get("name"),
      channel: fd.get("channel"),
      segment: fd.get("segment") ?? "all",
      subject: (fd.get("subject") as string | null) ?? undefined,
      // Builder/HTML campaigns store a plain-text projection in `body`
      // (fallback + legacy column); plain campaigns post body directly.
      body: bodyDoc
        ? docToPlainText(bodyDoc).slice(0, 2000)
        : htmlBody
          ? htmlToPlainText(htmlBody).slice(0, 2000) || "(custom HTML email)"
          : fd.get("body"),
      send: fd.get("send") === "now",
    });
  if (!parsed.success) {
    return { status: "error", message: "Please complete the campaign fields." };
  }

  const { venueId, name, channel, segment } = parsed.data;

  const planError = await checkCampaignPlan(orgId, channel, segment);
  if (planError) return { status: "error", message: planError };
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
      segment,
      status: "draft",
      subjectOverride: channel === "email" ? subject || null : null,
      body,
      bodyDoc,
      htmlBody,
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
    metadata: { channel, name, segment },
  });

  if (!parsed.data.send) {
    revalidatePath(`/dashboard/venues/${venueId}/campaigns`);
    return { status: "created", campaignId: campaign.id, queued: 0, sent: false };
  }

  // Fan out. Scheduled: sends sit dormant until scheduleAt (cron drains).
  // Send-now: drive the worker inline so the first batch lands immediately.
  const r = await enqueueCampaign(campaign.id, scheduleAt ? { now, scheduleAt } : { now });
  if (!r.ok && r.reason === "insufficient-credit") {
    // The campaign is saved as a draft; it just couldn't send for lack of
    // prepaid credit. Tell the operator how much they're short.
    revalidatePath(`/dashboard/venues/${venueId}/campaigns`);
    const need = (r.requiredPence / 100).toFixed(2);
    const have = (r.balancePence / 100).toFixed(2);
    return {
      status: "error",
      message: `Saved as a draft — not enough messaging credit to send (need £${need}, balance £${have}). Top up to send.`,
    };
  }
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

// On-demand audience estimate for a (channel, segment). Plus-gated +
// org-scoped. Called by the composer when channel/segment changes. Also
// returns the org's current credit balance so the composer can show it and
// block a send the balance can't cover.
// Email campaigns carry allowance context so the composer can show
// "X within allowance · Y chargeable ≈ £Z". `enforced` false = the
// display-only rollout window: numbers shown, nothing charged/blocked.
export type EmailBillingEstimate = {
  allowance: number;
  used: number;
  remaining: number;
  chargeable: number;
  enforced: boolean;
};

export type AudienceEstimateResult =
  | {
      ok: true;
      count: number;
      costPence: number;
      balancePence: number;
      emailBilling: EmailBillingEstimate | null;
    }
  | { ok: false; message: string };

export async function estimateCampaignAudience(input: {
  venueId: string;
  channel: string;
  segment: string;
}): Promise<AudienceEstimateResult> {
  const { orgId } = await requireRole("manager");
  const channel = CHANNEL.safeParse(input.channel);
  const segment = SEGMENT.safeParse(input.segment);
  const vid = z.uuid().safeParse(input.venueId);
  if (!channel.success || !segment.success || !vid.success) {
    return { ok: false, message: "Invalid selection." };
  }
  const planError = await checkCampaignPlan(orgId, channel.data, segment.data);
  if (planError) return { ok: false, message: planError };
  // Org guard before estimating against the venue.
  const [venue] = await adminDb()
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, vid.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false, message: "Venue not found." };

  const est = await estimateAudience(orgId, vid.data, channel.data, { segment: segment.data });
  const balancePence = await withUser((db) => getBalance(db, orgId));

  let costPence = est.costPence;
  let emailBilling: EmailBillingEstimate | null = null;
  if (channel.data === "email") {
    const plan = await getPlan(orgId);
    const state = await getEmailAllowanceState(orgId, plan, new Date());
    const chargeable = emailChargeableCount(est.count, state.remaining);
    const enforced = isEmailOverageEnforced();
    // Always show the would-be cost; it only gates the send when enforced.
    costPence = emailCampaignCostPence(
      est.count,
      state.remaining,
      MARKETING_EMAIL.overagePencePer1000[plan],
    );
    emailBilling = { ...state, chargeable, enforced };
  }
  return { ok: true, count: est.count, costPence, balancePence, emailBilling };
}

// Live preview of campaign copy against a sample guest. Plus-gated.
export type CampaignPreview =
  | {
      ok: true;
      kind: "email";
      subject: string;
      html: string;
      unknownTags: string[];
      htmlWarnings?: string[];
    }
  | { ok: true; kind: "sms" | "whatsapp"; body: string; unknownTags: string[] }
  | { ok: false; message: string };

export async function previewCampaign(input: {
  venueId: string;
  channel: string;
  subject?: string;
  body?: string;
  bodyDoc?: unknown;
  htmlBody?: string;
}): Promise<CampaignPreview> {
  const { orgId } = await requireRole("manager");
  const channel = CHANNEL.safeParse(input.channel);
  const vid = z.uuid().safeParse(input.venueId);
  if (!channel.success || !vid.success) return { ok: false, message: "Invalid selection." };
  const planError = await checkCampaignPlan(orgId, channel.data, "all");
  if (planError) return { ok: false, message: planError };

  const db = adminDb();
  const [venue] = await db
    .select({ name: venues.name, slug: venues.slug, settings: venues.settings })
    .from(venues)
    .where(and(eq(venues.id, vid.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false, message: "Venue not found." };

  // Optional block doc (email builder preview). Invalid docs surface as a
  // preview error rather than silently falling back.
  let doc: CampaignBodyDoc | null = null;
  if (input.bodyDoc !== undefined && input.bodyDoc !== null) {
    if (channel.data !== "email") return { ok: false, message: "Designs are email-only." };
    const r = parseBodyDoc(input.bodyDoc);
    if (!r.ok) return { ok: false, message: `Invalid email design — ${r.error}` };
    doc = r.doc;
  }

  // Optional custom HTML (raw paste — sanitised here, warnings surfaced).
  let cleanHtml: string | null = null;
  let htmlWarnings: string[] = [];
  if (input.htmlBody !== undefined && (input.htmlBody ?? "").trim() !== "") {
    if (channel.data !== "email") return { ok: false, message: "Custom HTML is email-only." };
    const r = sanitizeCampaignHtml(input.htmlBody!);
    if (!r.ok) return { ok: false, message: r.error };
    cleanHtml = combineHtml(r);
    htmlWarnings = r.warnings;
  }

  const body = (input.body ?? "").slice(0, 2000);
  const subject = (input.subject ?? "").slice(0, 200);
  const unknownTags = [
    ...(doc
      ? docTemplateStrings(doc).flatMap(findUnknownMarketingTags)
      : findUnknownMarketingTags(body)),
    ...findUnknownMarketingTags(subject),
  ];

  const rendered = await renderCampaign({
    channel: channel.data,
    subject: subject || null,
    body: body || "(your message)",
    bodyDoc: doc,
    htmlBody: cleanHtml,
    ctx: {
      guestFirstName: "Jamie",
      venueName: venue.name,
      unsubscribeUrl: "https://app.tablekit.uk/unsubscribe?p=sample",
      branding: parseBranding(venue.settings),
      ...campaignSurfaceCtx(venue.slug, vid.data),
    },
  });

  if (rendered.kind === "email") {
    return {
      ok: true,
      kind: "email",
      subject: rendered.rendered.subject,
      html: rendered.rendered.html,
      unknownTags,
      ...(htmlWarnings.length > 0 ? { htmlWarnings } : {}),
    };
  }
  return { ok: true, kind: rendered.kind, body: rendered.rendered.body, unknownTags };
}

// Upload an image for use in an email design. Org-guarded; stored in the
// public campaign-assets bucket under an org/venue-scoped path; the
// returned https URL goes into an image block (and re-passes the block
// schema's http(s) check). See lib/campaigns/assets.ts.
export type UploadCampaignImageResult = { ok: true; url: string } | { ok: false; message: string };

export async function uploadCampaignImage(formData: FormData): Promise<UploadCampaignImageResult> {
  const { orgId, userId } = await requireRole("manager");
  const planError = await checkCampaignPlan(orgId, "email", "all");
  if (planError) return { ok: false, message: planError };

  const vid = z.uuid().safeParse(formData.get("venue_id"));
  if (!vid.success) return { ok: false, message: "Invalid venue." };
  const [venue] = await adminDb()
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, vid.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false, message: "Venue not found." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Pick an image to upload." };
  }
  if (file.size > MAX_CAMPAIGN_IMAGE_BYTES) {
    return {
      ok: false,
      message: `Image is too large (max ${(MAX_CAMPAIGN_IMAGE_BYTES / 1_048_576).toFixed(0)}MB — emails should stay light).`,
    };
  }
  // Advisory UX check; the bucket's allowedMimeTypes is the enforcement.
  const ext = campaignImageExtensionForMime(file.type);
  if (!ext) return { ok: false, message: "Use a JPEG, PNG or WebP image." };

  const storagePath = `${orgId}/${vid.data}/${randomUUID()}.${ext}`;
  await uploadCampaignAssetObject(storagePath, Buffer.from(await file.arrayBuffer()), file.type);

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "campaign.image_uploaded",
    targetType: "venue",
    targetId: vid.data,
  });
  return { ok: true, url: campaignAssetPublicUrl(storagePath) };
}

// --- Saved templates (marketing-suite) --------------------------------------
// Org-scoped saved designs. Reads happen in the page via withUser (RLS);
// writes come through here (org implicit from the session, adminDb).

const MAX_TEMPLATES_PER_ORG = 20;

export type SaveTemplateResult =
  | { ok: true; id: string; name: string }
  | { ok: false; message: string };

export async function saveCampaignTemplate(input: {
  name: string;
  subject?: string;
  bodyDoc: unknown;
}): Promise<SaveTemplateResult> {
  const { orgId, userId } = await requireRole("manager");
  const planError = await checkCampaignPlan(orgId, "email", "all");
  if (planError) return { ok: false, message: planError };

  const name = (input.name ?? "").trim().slice(0, 80);
  if (!name) return { ok: false, message: "Give the template a name." };
  const parsed = parseBodyDoc(input.bodyDoc);
  if (!parsed.ok) return { ok: false, message: `Invalid design — ${parsed.error}` };
  const subject = (input.subject ?? "").trim().slice(0, 200) || null;

  const db = adminDb();
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignTemplates)
    .where(eq(campaignTemplates.organisationId, orgId));
  if (n >= MAX_TEMPLATES_PER_ORG) {
    return {
      ok: false,
      message: `You can save up to ${MAX_TEMPLATES_PER_ORG} templates — delete one first.`,
    };
  }

  const [row] = await db
    .insert(campaignTemplates)
    .values({ organisationId: orgId, name, subject, bodyDoc: parsed.doc, createdByUserId: userId })
    .returning({ id: campaignTemplates.id });
  if (!row) return { ok: false, message: "Couldn't save the template." };

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "campaign.template_saved",
    targetType: "campaign_template",
    targetId: row.id,
    metadata: { name },
  });
  return { ok: true, id: row.id, name };
}

export async function deleteCampaignTemplate(input: { id: string }): Promise<void> {
  const { orgId, userId } = await requireRole("manager");
  const id = z.uuid().safeParse(input.id);
  if (!id.success) return;
  const deleted = await adminDb()
    .delete(campaignTemplates)
    .where(and(eq(campaignTemplates.id, id.data), eq(campaignTemplates.organisationId, orgId)))
    .returning({ id: campaignTemplates.id });
  if (deleted.length > 0) {
    await audit.log({
      organisationId: orgId,
      actorUserId: userId,
      action: "campaign.template_deleted",
      targetType: "campaign_template",
      targetId: id.data,
    });
  }
}

// Send the current draft to the signed-in operator's own email. Deliberately
// NOT a campaign send: no campaign_sends row, no message_usage, no allowance
// consumption — test sends never count (spec acceptance criterion).
export type TestSendResult = { ok: true; to: string } | { ok: false; message: string };

export async function sendTestCampaignEmail(input: {
  venueId: string;
  subject?: string;
  body?: string;
  bodyDoc?: unknown;
  htmlBody?: string;
}): Promise<TestSendResult> {
  const { orgId, userId } = await requireRole("manager");
  const planError = await checkCampaignPlan(orgId, "email", "all");
  if (planError) return { ok: false, message: planError };

  const vid = z.uuid().safeParse(input.venueId);
  if (!vid.success) return { ok: false, message: "Invalid venue." };
  const db = adminDb();
  const [venue] = await db
    .select({ name: venues.name, slug: venues.slug, settings: venues.settings })
    .from(venues)
    .where(and(eq(venues.id, vid.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { ok: false, message: "Venue not found." };

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.email) return { ok: false, message: "Couldn't find your account email." };

  let doc: CampaignBodyDoc | null = null;
  if (input.bodyDoc !== undefined && input.bodyDoc !== null) {
    const r = parseBodyDoc(input.bodyDoc);
    if (!r.ok) return { ok: false, message: `Invalid email design — ${r.error}` };
    doc = r.doc;
  }

  let cleanHtml: string | null = null;
  if ((input.htmlBody ?? "").trim() !== "") {
    const r = sanitizeCampaignHtml(input.htmlBody!);
    if (!r.ok) return { ok: false, message: r.error };
    cleanHtml = combineHtml(r);
  }

  const sampleUnsub = "https://app.tablekit.uk/unsubscribe?p=sample";
  const rendered = await renderCampaign({
    channel: "email",
    subject: (input.subject ?? "").trim() || null,
    body: (input.body ?? "").slice(0, 2000) || "(your message)",
    bodyDoc: doc,
    htmlBody: cleanHtml,
    ctx: {
      guestFirstName: "Jamie",
      venueName: venue.name,
      unsubscribeUrl: sampleUnsub,
      branding: parseBranding(venue.settings),
      ...campaignSurfaceCtx(venue.slug, vid.data),
    },
  });
  if (rendered.kind !== "email") return { ok: false, message: "Test sends are email-only." };

  try {
    await sendEmail({
      to: user.email,
      subject: `[TEST] ${rendered.rendered.subject}`,
      html: rendered.rendered.html,
      text: rendered.rendered.text,
      unsubscribeUrl: sampleUnsub,
      // The sample unsubscribe URL is a plain page, not a one-click POST
      // endpoint — don't advertise RFC 8058 for it.
      oneClickUnsubscribe: false,
      idempotencyKey: `test_${userId}_${randomUUID()}`,
    });
  } catch {
    return { ok: false, message: "Couldn't send the test email — try again shortly." };
  }
  return { ok: true, to: user.email };
}
