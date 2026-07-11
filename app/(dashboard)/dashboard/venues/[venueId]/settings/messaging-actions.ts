"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { InsufficientPlanError, requirePlan } from "@/lib/auth/require-plan";
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
import {
  FLOW_EVENTS,
  FLOW_EVENT_TEMPLATE,
  mergeMessagingEvent,
  type FlowEvent,
} from "@/lib/messaging/venue-settings";
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

// Per-message save — flow settings for ONE event, plus (optionally) the
// copy override for one channel of that event, in a single submit. This
// is the action behind each expandable row on the Messages tab: the
// operator edits a message in one place and one button owns everything
// they can see.
export type MessageSaveState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "saved"; unknownTags: string[] };

export async function saveMessage(
  _prev: MessageSaveState,
  fd: FormData,
): Promise<MessageSaveState> {
  const { orgId, userId } = await requireRole("manager");
  const venueId = z.uuid().safeParse(fd.get("venue_id"));
  if (!venueId.success) return { status: "error", message: "Invalid venue." };
  const eventRaw = fd.get("event");
  if (typeof eventRaw !== "string" || !(FLOW_EVENTS as readonly string[]).includes(eventRaw)) {
    return { status: "error", message: "Unknown message." };
  }
  const event = eventRaw as FlowEvent;

  const r = readEvent(event, fd);
  if ("error" in r) return { status: "error", message: r.error };

  // SMS/WhatsApp are paid (pass-through) channels — gated Core+. Email
  // stays free for every tier. Catch InsufficientPlanError and surface
  // an upgrade prompt rather than 500ing.
  if (r.enabled && r.channels.some((c) => c === "sms" || c === "whatsapp")) {
    try {
      await requirePlan(orgId, "core");
    } catch (err) {
      if (err instanceof InsufficientPlanError) {
        return {
          status: "error",
          message: "SMS and WhatsApp are paid channels — upgrade to Core or higher to enable them.",
        };
      }
      throw err;
    }
  }

  // Validate the (optional) copy override BEFORE any write, so a bad
  // copy field can never leave a half-saved message. Present when the
  // row's copy editor has unsaved changes (copy_channel is set); blank
  // subject+body clears back to the default copy, mirroring the old
  // composer semantics.
  let copy: {
    channel: MessageChannel;
    subject: string;
    body: string;
    enabled: boolean;
  } | null = null;
  let unknownTags: string[] = [];
  const copyChannelRaw = fd.get("copy_channel");
  if (typeof copyChannelRaw === "string" && copyChannelRaw !== "") {
    const channel = CHANNEL.safeParse(copyChannelRaw);
    if (!channel.success || !templateChannels(FLOW_EVENT_TEMPLATE[event]).includes(channel.data)) {
      return { status: "error", message: "That channel isn't available for this message." };
    }
    const subjectRaw = fd.get("subject_override");
    const bodyRaw = fd.get("body_override");
    copy = {
      channel: channel.data,
      subject: (typeof subjectRaw === "string" ? subjectRaw : "").slice(0, 200).trim(),
      body: (typeof bodyRaw === "string" ? bodyRaw : "").slice(0, 2000).trim(),
      enabled: fd.get("copy_enabled") === "on",
    };
    unknownTags = [...findUnknownMergeTags(copy.body), ...findUnknownMergeTags(copy.subject)];
  }

  const db = adminDb();
  // Both writes in one transaction, with the venue row locked so a
  // concurrent save (e.g. Branding tab in another window) can't lose
  // this read-modify-write. The org filter carries the multi-tenant
  // weight — adminDb() bypasses RLS.
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ settings: venues.settings })
      .from(venues)
      .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)))
      .limit(1)
      .for("update");
    if (!existing) return "not-found" as const;

    // Merge just this event into the (fully-defaulted) stored config so
    // a per-message save can never clobber a sibling message's settings.
    await tx
      .update(venues)
      .set({ settings: mergeMessagingEvent(existing.settings, event, r) })
      .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)));

    if (copy) {
      await tx
        .insert(messageTemplates)
        .values({
          organisationId: orgId, // overwritten by enforce trigger from the venue
          venueId: venueId.data,
          template: FLOW_EVENT_TEMPLATE[event],
          channel: copy.channel,
          subjectOverride: copy.channel === "email" ? copy.subject || null : null,
          bodyOverride: copy.body || null,
          enabled: copy.enabled,
        })
        .onConflictDoUpdate({
          target: [messageTemplates.venueId, messageTemplates.template, messageTemplates.channel],
          set: {
            subjectOverride: copy.channel === "email" ? copy.subject || null : null,
            bodyOverride: copy.body || null,
            enabled: copy.enabled,
          },
        });
    }
    return "saved" as const;
  });
  if (outcome === "not-found") {
    return { status: "error", message: "Venue not found or not in your organisation." };
  }

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.messaging_settings_updated",
    targetType: "venue",
    targetId: venueId.data,
    // Validated enum values only — never override text.
    metadata: { event, ...(copy ? { copyChannel: copy.channel } : {}) },
  });

  revalidatePath(`/dashboard/venues/${venueId.data}/settings/messaging`, "layout");
  return { status: "saved", unknownTags };
}

// Branding save — venue-level, its own tab, its own action.
export async function updateBranding(
  _prev: MessagingSettingsState,
  fd: FormData,
): Promise<MessagingSettingsState> {
  const { orgId, userId } = await requireRole("manager");
  const venueId = z.uuid().safeParse(fd.get("venue_id"));
  if (!venueId.success) return { status: "error", message: "Invalid venue." };

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
  // Match the read-path constraint (parseBranding) so we don't silently
  // store an http: logo that the widget then drops as mixed content.
  if (logoUrlRaw && !logoUrlRaw.startsWith("https://")) {
    return { status: "error", message: "Logo URL must start with https://." };
  }
  const replyToRaw = (fd.get("reply_to") as string | null)?.trim() ?? "";
  if (replyToRaw && !z.string().email().safeParse(replyToRaw).success) {
    return { status: "error", message: "Reply-to must be a valid email." };
  }
  // Widget-only corner treatment. Stored for all tiers (free for emails to
  // ignore); applied to the widget only when the org is on Plus, gated at
  // render time in lib/branding/theme.ts.
  const cornerStyleRaw = (fd.get("corner_style") as string | null)?.trim() ?? "";
  const cornerStyle: "rounded" | "sharp" | null =
    cornerStyleRaw === "sharp" ? "sharp" : cornerStyleRaw === "rounded" ? "rounded" : null;
  const branding = {
    logoUrl: logoUrlRaw || null,
    brandColour: brandColourRaw || null,
    signature: ((fd.get("signature") as string | null)?.trim() || "").slice(0, 500) || null,
    replyTo: replyToRaw || null,
    cornerStyle,
  };

  const db = adminDb();
  // Lock the venue row for the read-modify-write so a concurrent save
  // (e.g. the Messages tab in another window) can't lose this branding
  // write. Mirrors saveMessage above. The org filter carries the
  // multi-tenant weight — adminDb() bypasses RLS.
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ settings: venues.settings })
      .from(venues)
      .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)))
      .limit(1)
      .for("update");
    if (!existing) return "not-found" as const;

    await tx
      .update(venues)
      .set({
        settings: {
          ...((existing.settings as Record<string, unknown>) ?? {}),
          branding,
        },
      })
      .where(and(eq(venues.id, venueId.data), eq(venues.organisationId, orgId)));
    return "saved" as const;
  });
  if (outcome === "not-found")
    return { status: "error", message: "Venue not found or not in your organisation." };

  await audit.log({
    organisationId: orgId,
    actorUserId: userId,
    action: "venue.branding_updated",
    targetType: "venue",
    targetId: venueId.data,
  });

  revalidatePath(`/dashboard/venues/${venueId.data}/settings/messaging`, "layout");
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

// (The standalone override composer action was folded into saveMessage
// above — one row, one save. previewMessage below still serves drafts.)

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
  unsubscribeUrl: "https://my.tablekitapp.com/unsubscribe?p=sample",
  reviewUrl: "https://my.tablekitapp.com/review?p=sample",
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
