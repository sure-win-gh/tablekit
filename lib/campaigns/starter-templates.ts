// Seeded starter designs for the email builder (marketing-suite:
// templates). Code-defined (not DB rows) so every org gets them, they
// version with the codebase, and there's nothing to seed per tenant.
// Each starter is a full CampaignBodyDoc — validated by a unit test
// against the block schema so a schema change can never ship a broken
// starter. Copy leans on merge tags + the bookingCta block, so starters
// work for any venue with zero editing.
//
// Pure (no server-only): the client picker renders names/descriptions and
// loads docs directly.

import type { CampaignBodyDoc } from "./blocks";

export type StarterTemplate = {
  key: string;
  name: string;
  description: string;
  subject: string;
  doc: CampaignBodyDoc;
};

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    key: "event",
    name: "Event announcement",
    description: "A special evening — supper club, tasting night, live music.",
    subject: "You're invited: a special evening at {{venueName}}",
    doc: {
      v: 1,
      theme: { font: "classic", buttonShape: "rounded" },
      blocks: [
        { type: "heading", text: "A special evening at {{venueName}}", level: 1, align: "center" },
        {
          type: "text",
          text: "Hi {{guestFirstName}},\n\nWe're doing something a little different — and we'd love you to be there. One night only: a set menu, a full room, and the kind of atmosphere we can't do on a normal service.",
        },
        { type: "spacer", size: "s" },
        { type: "bookingCta", label: "Reserve your table", style: "filled", align: "center" },
        { type: "divider" },
        {
          type: "text",
          text: "Seats are limited and these evenings tend to go quickly. If the date doesn't work, reply and we'll let you know about the next one.",
          size: "s",
        },
      ],
    },
  },
  {
    key: "new-menu",
    name: "New menu",
    description: "Announce a seasonal or refreshed menu.",
    subject: "The new menu at {{venueName}} has landed",
    doc: {
      v: 1,
      blocks: [
        { type: "heading", text: "The new menu is here", level: 1 },
        {
          type: "text",
          text: "Hi {{guestFirstName}},\n\nWe've been in the kitchen. The new menu at {{venueName}} is on now — same favourites you'd riot over if we removed, plus a few things we're genuinely excited for you to try.",
        },
        { type: "bookingCta", label: "Book a table", style: "filled" },
        {
          type: "text",
          text: "First week tip: come hungry.",
          size: "s",
        },
      ],
    },
  },
  {
    key: "quiet-night",
    name: "Quiet-night offer",
    description: "Fill slower nights with a midweek offer.",
    subject: "A midweek treat at {{venueName}}",
    doc: {
      v: 1,
      theme: { buttonShape: "pill" },
      blocks: [
        { type: "heading", text: "Midweek, but make it special", level: 1 },
        {
          type: "text",
          text: "Hi {{guestFirstName}},\n\nMidweek evenings at {{venueName}} are calmer, cosier, and — this month — better value. Join us and we'll take care of the rest.",
        },
        { type: "spacer", size: "s" },
        { type: "bookingCta", label: "Book a midweek table", style: "filled" },
        { type: "divider" },
        {
          type: "text",
          text: "Offer applies to selected midweek services. Add your terms here before sending.",
          size: "s",
        },
      ],
    },
  },
  {
    key: "newsletter",
    name: "Monthly newsletter",
    description: "News, dates and a booking nudge in one.",
    subject: "What's happening at {{venueName}}",
    doc: {
      v: 1,
      theme: { font: "elegant" },
      blocks: [
        { type: "heading", text: "News from {{venueName}}", level: 1 },
        {
          type: "text",
          text: "Hi {{guestFirstName}},\n\nHere's what's been happening — and what's coming up.",
        },
        { type: "divider" },
        { type: "heading", text: "This month", level: 2 },
        {
          type: "text",
          text: "Write your first story here. **Bold** the good bits, keep it short, and let the pictures do the talking.",
        },
        { type: "divider" },
        { type: "heading", text: "Coming up", level: 2 },
        { type: "text", text: "Dates for the diary — add your events here." },
        { type: "spacer", size: "s" },
        { type: "bookingCta", label: "Book your next visit", style: "outline" },
      ],
    },
  },
];
