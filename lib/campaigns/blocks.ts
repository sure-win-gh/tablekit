// Campaign email block document — the structured body behind the email
// builder (docs/specs/marketing-suite.md, Phase A).
//
// Pure (no server-only): the client builder composes/validates the same
// schema the server actions re-validate. Operator-supplied JSON is
// UNTRUSTED input — everything is zod-parsed at the boundary, all text is
// rendered through React (escaped), and every URL is confined to
// http(s) so a stored doc can never smuggle javascript: links or markup
// into rendered emails.
//
// Phase A blocks: heading, text, image, button, divider, spacer.
// Phase C adds bookingCta / countdown / eventCard / social / columns —
// extend the union + renderer together, and bump DOC_VERSION only on a
// breaking shape change (renderers must keep reading old versions).

import { z } from "zod";

export const DOC_VERSION = 1;
export const MAX_BLOCKS = 40;

// http(s)-only absolute URL. Rejects javascript:, data:, protocol-relative
// and anything unparseable.
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "Must be an http(s) URL");

// Colours are strict 6-digit hex — the same rule venue branding uses, and
// what stops a "colour" from smuggling arbitrary CSS into inline styles.
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour like #b3541e");

// Email-safe font stacks. A curated enum rather than free entry: Gmail/
// Outlook strip custom web fonts, so these stacks are what actually
// renders in inboxes. The key is stored in the doc; the stack is applied
// by the renderer.
export const FONT_STACKS = {
  modern: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  classic: "Georgia, 'Times New Roman', Times, serif",
  elegant: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  mono: "'Courier New', Courier, monospace",
} as const;
export type FontStackKey = keyof typeof FONT_STACKS;

const align = z.enum(["left", "center"]);

// Doc-level theme — set once, applies everywhere; block-level fields
// override it. Everything optional: an absent theme means "venue branding
// + platform defaults", so pre-theme docs render exactly as before.
export const themeSchema = z.object({
  font: z.enum(["modern", "classic", "elegant", "mono"]).optional(),
  accent: hexColour.optional(), // default = venue brand colour
  textColour: hexColour.optional(),
  buttonShape: z.enum(["square", "rounded", "pill"]).optional(),
});
export type DocTheme = z.infer<typeof themeSchema>;

const headingBlock = z.object({
  type: z.literal("heading"),
  text: z.string().trim().min(1).max(150), // merge tags OK
  level: z.union([z.literal(1), z.literal(2)]).default(2),
  colour: hexColour.optional(), // default: theme accent → brand colour
  align: align.optional(),
});

const textBlock = z.object({
  type: z.literal("text"),
  // Plain text + merge tags + a limited inline syntax handled by the
  // renderer: **bold**, *italic*, [label](https://link). Blank lines
  // split paragraphs.
  text: z.string().trim().min(1).max(2000),
  colour: hexColour.optional(), // default: theme text colour
  size: z.enum(["s", "m", "l"]).optional(),
  align: align.optional(),
});

const imageBlock = z.object({
  type: z.literal("image"),
  src: httpUrl,
  alt: z.string().trim().min(1).max(200), // required — accessibility
  href: httpUrl.optional(),
  widthPct: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).default(100),
});

const buttonBlock = z.object({
  type: z.literal("button"),
  label: z.string().trim().min(1).max(80), // merge tags OK
  url: httpUrl,
  style: z.enum(["filled", "outline"]).default("filled"),
  colour: hexColour.optional(), // default: theme accent → brand colour
  align: align.optional(),
});

const dividerBlock = z.object({
  type: z.literal("divider"),
  colour: hexColour.optional(),
});

const spacerBlock = z.object({
  type: z.literal("spacer"),
  size: z.enum(["s", "m", "l"]).default("m"),
});

// Booking CTA (Phase C): a button whose URL is BUILT by the renderer from
// the venue's own booking page (+ optional party/date prefill) — so it
// always points at the right surface and always carries attribution
// (?tk_c=) on real sends. The operator never types a URL.
const bookingCtaBlock = z.object({
  type: z.literal("bookingCta"),
  label: z.string().trim().min(1).max(80), // merge tags OK
  party: z.number().int().min(1).max(20).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  style: z.enum(["filled", "outline"]).default("filled"),
  colour: hexColour.optional(),
  align: align.optional(),
});

// Countdown (Phase C): renders as a self-hosted dynamic image
// (/api/countdown/<signed token>) showing time remaining at open time.
// The token carries only the target instant — no guest identifiers.
const countdownBlock = z.object({
  type: z.literal("countdown"),
  target: z
    .string()
    .trim()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Must be a valid date/time"),
  caption: z.string().trim().max(150).optional(),
});

// Social links (Phase C): explicit operator-entered profile URLs (venue
// settings has no socials slice yet — revisit when it does).
const socialBlock = z
  .object({
    type: z.literal("social"),
    instagram: httpUrl.optional(),
    facebook: httpUrl.optional(),
    x: httpUrl.optional(),
    website: httpUrl.optional(),
  })
  .refine((b) => Boolean(b.instagram || b.facebook || b.x || b.website), "Add at least one link");

export const blockSchema = z.discriminatedUnion("type", [
  headingBlock,
  textBlock,
  imageBlock,
  buttonBlock,
  dividerBlock,
  spacerBlock,
  bookingCtaBlock,
  countdownBlock,
  socialBlock,
]);

export const bodyDocSchema = z.object({
  v: z.literal(DOC_VERSION),
  theme: themeSchema.optional(),
  blocks: z.array(blockSchema).min(1).max(MAX_BLOCKS),
});

export type CampaignBlock = z.infer<typeof blockSchema>;
export type CampaignBodyDoc = z.infer<typeof bodyDocSchema>;

// Boundary parse for untrusted JSON (form field / jsonb column). Returns
// a Result rather than throwing — callers surface the message to the UI.
export function parseBodyDoc(
  raw: unknown,
): { ok: true; doc: CampaignBodyDoc } | { ok: false; error: string } {
  const r = bodyDocSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join(".") || "doc"}: ${first.message}` : "Invalid email design.",
    };
  }
  return { ok: true, doc: r.data };
}

// Every operator-authored template string in the doc — merge-tag
// validation (findUnknownMarketingTags) runs across all of them.
export function docTemplateStrings(doc: CampaignBodyDoc): string[] {
  return doc.blocks.flatMap((b) => {
    switch (b.type) {
      case "heading":
        return [b.text];
      case "text":
        return [b.text];
      case "button":
        return [b.label];
      case "bookingCta":
        return [b.label];
      default:
        return [];
    }
  });
}

// Plain-text projection of the doc. Fills campaigns.body (not-null legacy
// column + the plain-text sibling for previews); the real plain-text MIME
// part is produced by the renderer from the same blocks.
export function docToPlainText(doc: CampaignBodyDoc): string {
  const lines = doc.blocks.map((b) => {
    switch (b.type) {
      case "heading":
        return b.text;
      case "text":
        return b.text;
      case "image":
        return b.alt;
      case "button":
        return `${b.label}: ${b.url}`;
      case "bookingCta":
        return b.label;
      case "countdown":
        return b.caption ?? "";
      case "social":
        return [b.instagram, b.facebook, b.x, b.website].filter(Boolean).join("\n");
      case "divider":
        return "—";
      case "spacer":
        return "";
    }
  });
  return lines
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
