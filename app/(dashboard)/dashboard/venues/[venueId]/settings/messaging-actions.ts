"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { messageTemplates, venues } from "@/lib/db/schema";
import type { MessageBookingContext } from "@/lib/messaging/context";
import { findUnknownMergeTags } from "@/lib/messaging/merge-tags";
import {
  templateChannels,
  type MessageChannel,
  type MessageTemplate,
} from "@/lib/messaging/registry";
import { renderMessage } from "@/lib/messaging/render-message";
import { FLOW_EVENTS, FLOW_EVENT_TEMPLATE, type FlowEvent } from "@/lib/messaging/venue-settings";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";

// ---------------------------------------------------------------------------
// Flow + branding — persisted into venues.settings.{messaging,branding}
// ---------------------------------------------------------------------------

const CHANNEL = z.enum(["email", "sms", "whatsapp"]);
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type MessagingSettingsState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved" };

// Build one event's config from the posted fields. channels = [primary]
// or [primary, secondary], intersected with what the template can render
// so an operator can't pick a channel the message has no renderer for.
function readEvent(
  event: FlowEvent,
  fd: FormData,
):
  | {
      enabled: boolean;
      channels: MessageChannel[];
      hoursBeforeStart?: number;
      hoursAfterFinish?: number;
    }
  | { error: string } {
  const capable = new Set(templateChannels(FLOW_EVENT_TEMPLATE[event]));
  const enabled = fd.get(`${event}_enabled`) === "on";
  const primary = CHANNEL.safeParse(fd.get(`${event}_primary`));
  if (!primary.success) return { error: `${event}: pick a channel` };
  if (!capable.has(primary.data)) return { error: `${event}: ${primary.data} not available` };
  const channels: MessageChannel[] = [primary.data];
  const secondaryRaw = fd.get(`${event}_secondary`);
  if (typeof secondaryRaw === "string" && secondaryRaw && secondaryRaw !== "none") {
    const secondary = CHANNEL.safeParse(secondaryRaw);
    if (secondary.success && capable.has(secondary.data) && secondary.data !== primary.data) {
      channels.push(secondary.data);
    }
  }

  const out: {
    enabled: boolean;
    channels: MessageChannel[];
    hoursBeforeStart?: number;
    hoursAfterFinish?: number;
  } = {
    enabled,
    channels,
  };

  if (event === "reminder_24h" || event === "reminder_2h") {
    const h = z.coerce
      .number()
      .int()
      .min(1)
      .max(168)
      .safeParse(fd.get(`${event}_hours`));
    if (!h.success) return { error: `${event}: timing must be 1–168 hours before` };
    out.hoursBeforeStart = h.data;
  }
  if (event === "thank_you") {
    const h = z.coerce
      .number()
      .int()
      .min(1)
      .max(72)
      .safeParse(fd.get(`${event}_hours`));
    if (!h.success) return { error: `${event}: timing must be 1–72 hours after` };
    out.hoursAfterFinish = h.data;
  }
  return out;
}

export async function updateMessagingSettings(
  _prev: MessagingSettingsState,
  fd: FormData,
): Promise<MessagingSettingsState> {
  const { orgId, userId } = await requireRole("manager");
  const venueId = z.uuid().safeParse(fd.get("venue_id"));
  if (!venueId.success) return { status: "error", message: "Invalid venue." };

  const messaging: Record<string, unknown> = {};
  for (const event of FLOW_EVENTS) {
    const r = readEvent(event, fd);
    if ("error" in r) return { status: "error", message: r.error };
    messaging[event] = r;
  }

  // Branding — all optional, validated so nothing unsafe reaches the
  // email layout's inline styles.
  const brandColourRaw = (fd.get("brand_colour") as string | null)?.trim() ?? "";
  if (brandColourRaw && !HEX_COLOUR.test(brandColourRaw)) {
    return { status: "error", message: "Brand colour must be a hex value like #c2410c." };
  }
  const logoUrlRaw = (fd.get("logo_url") as string | null)?.trim() ?? "";
  if (logoUrlRaw && !z.string().url().safeParse(logoUrlRaw).success) {
    return { status: "error", message: "Logo URL must be a valid URL." };
  }
  const replyToRaw = (fd.get("reply_to") as string | null)?.trim() ?? "";
  if (replyToRaw && !z.string().email().safeParse(replyToRaw).success) {
    return { status: "error", message: "Reply-to must be a valid email." };
  }
  const branding = {
    logoUrl: logoUrlRaw || null,
    brandColour: brandColourRaw || null,
    signature: ((fd.get("signature") as string | null)?.trim() || "").slice(0, 500) || null,
    replyTo: replyToRaw || null,
  };

  const db = adminDb();
  const [existing] = await db
    .select({ settings: venues.settings })
    .from(venues)
    .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!existing)
    return { status: "error", message: "Venue not found or not in your organisation." };

  const merged = {
    ...((existing.settings as Record<string, unknown>) ?? {}),
    messaging,
    branding,
  };

  await db
    .update(venues)
    .set({ settings: merged })
    .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)));

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.messaging_settings_updated",
    targetType: "venue",
    targetId: venueId.data,
  });

  revalidatePath(`/dashboard/venues/${venueId.data}/settings`, "layout");
  return { status: "saved" };
}

// ---------------------------------------------------------------------------
// Content overrides — message_templates rows
// ---------------------------------------------------------------------------

const TEMPLATE = z.enum([
  "booking.confirmation",
  "booking.reminder_24h",
  "booking.reminder_2h",
  "booking.cancelled",
  "booking.thank_you",
]);

export type OverrideState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; unknownTags: string[] };

export async function upsertMessageTemplate(
  _prev: OverrideState,
  fd: FormData,
): Promise<OverrideState> {
  const { orgId, userId } = await requireRole("manager");

  const parsed = z
    .object({
      venueId: z.uuid(),
      template: TEMPLATE,
      channel: CHANNEL,
      subjectOverride: z.string().max(200).optional(),
      bodyOverride: z.string().max(2000).optional(),
      enabled: z.boolean(),
    })
    .safeParse({
      venueId: fd.get("venue_id"),
      template: fd.get("template"),
      channel: fd.get("channel"),
      subjectOverride: (fd.get("subject_override") as string | null) ?? undefined,
      bodyOverride: (fd.get("body_override") as string | null) ?? undefined,
      enabled: fd.get("enabled") === "on",
    });
  if (!parsed.success) return { status: "error", message: "Please check the message fields." };

  const { venueId, template, channel } = parsed.data;
  const body = parsed.data.bodyOverride?.trim() ?? "";
  const subject = parsed.data.subjectOverride?.trim() ?? "";

  // The chosen channel must be renderable for this template.
  if (!templateChannels(template as MessageTemplate).includes(channel)) {
    return { status: "error", message: `${channel} is not available for this message.` };
  }

  const unknownTags = [...findUnknownMergeTags(body), ...findUnknownMergeTags(subject)];

  const db = adminDb();
  // Org check: the venue must belong to the actor's org. adminDb()
  // bypasses RLS so this guard carries the multi-tenant weight.
  const [venue] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), eq(venues.organisationId, orgId)))
    .limit(1);
  if (!venue) return { status: "error", message: "Venue not found or not in your organisation." };

  await db
    .insert(messageTemplates)
    .values({
      organisationId: orgId, // overwritten by enforce trigger from the venue
      venueId,
      template,
      channel,
      subjectOverride: channel === "email" ? subject || null : null,
      bodyOverride: body || null,
      enabled: parsed.data.enabled,
    })
    .onConflictDoUpdate({
      target: [messageTemplates.venueId, messageTemplates.template, messageTemplates.channel],
      set: {
        subjectOverride: channel === "email" ? subject || null : null,
        bodyOverride: body || null,
        enabled: parsed.data.enabled,
      },
    });

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.message_template_updated",
    targetType: "venue",
    targetId: venueId,
    metadata: { template, channel, enabled: parsed.data.enabled },
  });

  revalidatePath(`/dashboard/venues/${venueId}/settings`, "layout");
  return { status: "saved", unknownTags };
}

// ---------------------------------------------------------------------------
// Live preview — render sample output from a draft override
// ---------------------------------------------------------------------------

const SAMPLE_CTX: MessageBookingContext = {
  bookingId: "00000000-0000-0000-0000-000000000000",
  reference: "ABC-123",
  guestFirstName: "Jamie",
  partySize: 4,
  startAtLocal: "Sat 7 Jun 2026, 7:30 PM",
  endAtLocal: "Sat 7 Jun 2026, 9:30 PM",
  venueName: "Your Venue",
  venueLocale: "en-GB",
  serviceName: "Dinner",
  notes: null,
  unsubscribeUrl: "https://app.tablekit.uk/unsubscribe?p=sample",
  reviewUrl: "https://app.tablekit.uk/review?p=sample",
};

export type PreviewResult =
  | { ok: true; kind: "email"; subject: string; html: string; unknownTags: string[] }
  | { ok: true; kind: "sms" | "whatsapp"; body: string; unknownTags: string[] }
  | { ok: false; message: string };

export async function previewMessage(input: {
  template: string;
  channel: string;
  subjectOverride?: string;
  bodyOverride?: string;
}): Promise<PreviewResult> {
  await requireRole("manager");
  const template = TEMPLATE.safeParse(input.template);
  const channel = CHANNEL.safeParse(input.channel);
  if (!template.success || !channel.success) return { ok: false, message: "Invalid selection." };

  // Bound the same as the persist path so a draft preview can't trigger
  // an unbounded server-side render.
  const body = (input.bodyOverride ?? "").slice(0, 2000);
  const subject = (input.subjectOverride ?? "").slice(0, 200);
  const unknownTags = [...findUnknownMergeTags(body), ...findUnknownMergeTags(subject)];

  const rendered = await renderMessage(template.data as MessageTemplate, channel.data, SAMPLE_CTX, {
    subjectOverride: subject || null,
    bodyOverride: body || null,
    enabled: true,
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
  if (rendered.kind === "sms" || rendered.kind === "whatsapp") {
    return { ok: true, kind: rendered.kind, body: rendered.rendered.body, unknownTags };
  }
  return { ok: false, message: "No renderer for that combination." };
}
