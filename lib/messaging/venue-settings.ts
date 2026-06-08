// Typed parser for the messaging slice of venues.settings.
//
// Before this, every consumer read venues.settings as
// `Record<string, unknown>` and re-derived its own defaults inline.
// This module is the single source of truth for the lifecycle-message
// flow config: per-event enable flag, channel preference order, and
// timing — all fully defaulted so an empty `{}` reproduces today's
// shipped behaviour exactly.
//
// Scope: the five operator-controllable lifecycle events below.
// `booking.review_request` keeps its existing dedicated settings keys
// (reviewRequestEnabled / reviewRequestDelayHours) + its own trigger
// path — not duplicated here.

import "server-only";

import { z } from "zod";

import type { VenueBranding } from "./context";
import type { MessageChannel, MessageTemplate } from "./registry";

// The lifecycle events this module governs, mapped to their template.
export const FLOW_EVENTS = [
  "confirmation",
  "reminder_24h",
  "reminder_2h",
  "cancelled",
  "thank_you",
] as const;
export type FlowEvent = (typeof FLOW_EVENTS)[number];

export const FLOW_EVENT_TEMPLATE: Record<FlowEvent, MessageTemplate> = {
  confirmation: "booking.confirmation",
  reminder_24h: "booking.reminder_24h",
  reminder_2h: "booking.reminder_2h",
  cancelled: "booking.cancelled",
  thank_you: "booking.thank_you",
};

const CHANNEL = z.enum(["email", "sms", "whatsapp"]);

// Timing bounds — a typo must not schedule a reminder 400 days out.
const HOURS_BEFORE_MIN = 1;
const HOURS_BEFORE_MAX = 168; // 7 days
const HOURS_AFTER_MIN = 1;
const HOURS_AFTER_MAX = 72;

const eventSchema = z.object({
  enabled: z.boolean(),
  // Operator channel-preference order. First deliverable channel wins
  // at resolve time (intersected with registry capability + guest
  // suppression). Deduped, order preserved.
  channels: z.array(CHANNEL).min(1),
  // Reminders: hours before start_at. Other events ignore it.
  hoursBeforeStart: z.number().int().min(HOURS_BEFORE_MIN).max(HOURS_BEFORE_MAX).optional(),
  // thank_you: hours after finished. Other events ignore it.
  hoursAfterFinish: z.number().int().min(HOURS_AFTER_MIN).max(HOURS_AFTER_MAX).optional(),
});

export type FlowEventSettings = z.infer<typeof eventSchema>;
export type MessagingSettings = Record<FlowEvent, FlowEventSettings>;

// Defaults reproduce the pre-Phase-2 hardcoded behaviour: same single
// channel each template historically used, same 24h/2h/3h timings.
const DEFAULTS: MessagingSettings = {
  confirmation: { enabled: true, channels: ["email"] },
  reminder_24h: { enabled: true, channels: ["email"], hoursBeforeStart: 24 },
  reminder_2h: { enabled: true, channels: ["sms"], hoursBeforeStart: 2 },
  cancelled: { enabled: true, channels: ["email"] },
  thank_you: { enabled: true, channels: ["email"], hoursAfterFinish: 3 },
};

function dedupe(channels: MessageChannel[]): MessageChannel[] {
  return [...new Set(channels)];
}

// Parse one event's raw settings, falling back to the default on any
// malformed field. Lenient by design: a bad stored value must never
// stop a transactional message — we degrade to the shipped default.
function parseEvent(event: FlowEvent, raw: unknown): FlowEventSettings {
  const def = DEFAULTS[event];
  const result = eventSchema.safeParse(raw);
  if (!result.success) return def;
  return {
    enabled: result.data.enabled,
    channels: dedupe(result.data.channels),
    ...(def.hoursBeforeStart !== undefined
      ? { hoursBeforeStart: result.data.hoursBeforeStart ?? def.hoursBeforeStart }
      : {}),
    ...(def.hoursAfterFinish !== undefined
      ? { hoursAfterFinish: result.data.hoursAfterFinish ?? def.hoursAfterFinish }
      : {}),
  };
}

// Read venues.settings.messaging into a fully-defaulted, typed object.
export function parseMessagingSettings(settings: unknown): MessagingSettings {
  const root =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)["messaging"]
      : undefined;
  const raw = root && typeof root === "object" ? (root as Record<string, unknown>) : {};
  const out = {} as MessagingSettings;
  for (const event of FLOW_EVENTS) {
    out[event] = parseEvent(event, raw[event]);
  }
  return out;
}

export { DEFAULTS as MESSAGING_SETTINGS_DEFAULTS };

// --- Branding ---------------------------------------------------------------
// Hex colour guard: #RGB or #RRGGBB only — never lets arbitrary CSS into
// the email layout's inline style or the widget's themed wrapper.
// Exported so the widget theming helper (lib/branding/theme.ts) and the
// dashboard form re-check operator input against the same canonical guard.
export const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Logos now load on the public widget over HTTPS (an http: URL would be
// blocked by CSP / mixed-content anyway) — constrain at the schema too.
const isHttps = (v: string) => v.startsWith("https://");

const brandingSchema = z.object({
  logoUrl: z.string().url().max(2048).refine(isHttps).nullish(),
  brandColour: z.string().regex(HEX_COLOUR).nullish(),
  signature: z.string().max(500).nullish(),
  replyTo: z.string().email().max(254).nullish(),
  cornerStyle: z.enum(["rounded", "sharp"]).nullish(),
});

// Parse venues.settings.branding into a typed object, or undefined when
// absent/empty so the email layout falls back to the shipped neutral
// shell. Lenient: a malformed field drops out rather than failing send.
export function parseBranding(settings: unknown): VenueBranding | undefined {
  const root =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)["branding"]
      : undefined;
  if (!root || typeof root !== "object") return undefined;
  const parsed = brandingSchema.safeParse(root);
  if (!parsed.success) {
    // Salvage individual valid fields rather than dropping all branding.
    const raw = root as Record<string, unknown>;
    const out: VenueBranding = {};
    if (typeof raw["logoUrl"] === "string" && isHttps(raw["logoUrl"])) out.logoUrl = raw["logoUrl"];
    if (typeof raw["brandColour"] === "string" && HEX_COLOUR.test(raw["brandColour"])) {
      out.brandColour = raw["brandColour"];
    }
    if (typeof raw["signature"] === "string") out.signature = raw["signature"].slice(0, 500);
    if (raw["cornerStyle"] === "rounded" || raw["cornerStyle"] === "sharp") {
      out.cornerStyle = raw["cornerStyle"];
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  const b: VenueBranding = {};
  if (parsed.data.logoUrl) b.logoUrl = parsed.data.logoUrl;
  if (parsed.data.brandColour) b.brandColour = parsed.data.brandColour;
  if (parsed.data.signature) b.signature = parsed.data.signature;
  if (parsed.data.replyTo) b.replyTo = parsed.data.replyTo;
  if (parsed.data.cornerStyle) b.cornerStyle = parsed.data.cornerStyle;
  return Object.keys(b).length > 0 ? b : undefined;
}
