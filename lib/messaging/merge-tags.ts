// Safe merge-tag interpolation for operator-authored message copy.
//
// Operators edit copy with a FIXED, closed set of {{tags}} — no
// arbitrary expressions, no HTML, no script. We substitute known tags
// with values from the booking context and leave unknown tags for the
// preview to flag. Values are returned as plain text; the email render
// layer escapes + nl2br's them, so an operator can never inject markup.

import "server-only";

import type { MessageBookingContext } from "./context";

// The closed allow-list. Adding a tag is a deliberate change here.
export const MERGE_TAGS = {
  guestFirstName: (c: MessageBookingContext) => c.guestFirstName,
  venueName: (c: MessageBookingContext) => c.venueName,
  startAtLocal: (c: MessageBookingContext) => c.startAtLocal,
  endAtLocal: (c: MessageBookingContext) => c.endAtLocal,
  partySize: (c: MessageBookingContext) => String(c.partySize),
  reference: (c: MessageBookingContext) => c.reference,
  serviceName: (c: MessageBookingContext) => c.serviceName,
} as const satisfies Record<string, (c: MessageBookingContext) => string>;

export type MergeTag = keyof typeof MERGE_TAGS;

export const MERGE_TAG_NAMES = Object.keys(MERGE_TAGS) as MergeTag[];

// Matches {{ tag }} with optional surrounding whitespace; tag is an
// identifier. We accept digits/underscores too (wider than the live tag
// names) so a typo like {{guest_first_name}} or {{partySize2}} is
// captured and surfaces in findUnknownTags rather than silently
// passing through unmatched.
const TAG_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

// Generic substitution: `resolve(name)` returns the value for a known
// tag, or undefined to leave the literal `{{tag}}` in place. Used by
// both the booking (transactional) and campaign (marketing) tag sets.
export function interpolateTemplate(
  template: string,
  resolve: (name: string) => string | undefined,
): string {
  return template.replace(TAG_RE, (whole, name: string) => {
    const v = resolve(name);
    return v === undefined ? whole : v;
  });
}

// Distinct tag names in the text that `isKnown` rejects — for preview
// validation.
export function findUnknownTags(template: string, isKnown: (name: string) => boolean): string[] {
  const unknown = new Set<string>();
  for (const m of template.matchAll(TAG_RE)) {
    const name = m[1]!;
    if (!isKnown(name)) unknown.add(name);
  }
  return [...unknown];
}

// Substitute the booking tag set; leave unknown {{tags}} untouched.
export function interpolateMergeTags(template: string, ctx: MessageBookingContext): string {
  return interpolateTemplate(template, (name) => {
    const fn = (MERGE_TAGS as Record<string, (c: MessageBookingContext) => string>)[name];
    return fn ? fn(ctx) : undefined;
  });
}

export function findUnknownMergeTags(template: string): string[] {
  return findUnknownTags(template, (name) => name in MERGE_TAGS);
}

// Legally-required opt-out instruction for operator-authored SMS /
// WhatsApp copy. Re-applied unless the operator already wrote the actual
// "reply STOP" phrase — matching the phrase, NOT the bare word "stop"
// (a body mentioning "the bus stop" must still get the line). PECR /
// gdpr.md LIA depend on it always being present.
export const OPT_OUT_LINE = "Reply STOP to opt out.";

export function ensureOptOut(body: string): string {
  return /reply\s+stop/i.test(body) ? body : `${body.trimEnd()} ${OPT_OUT_LINE}`;
}

// HTML-escape operator text + merge values so nothing they type can
// inject markup, then convert newlines to <br/> for email bodies.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToHtmlParagraphs(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br/>");
}
