// The marketing feature registry — the single source of truth that keeps
// the home highlights, the pricing matrix and the /features pages from
// drifting apart. Adding one entry updates all three at once.
//
// Seed it ONLY from shipped, customer-visible features (see
// docs/specs/index.md). Internal/infra specs (admin-dashboard,
// stripe-billing) and not-yet-shipped drafts stay out until they ship —
// that gap is the point: /ship's marketing-sync gate adds them here when
// they go live.
//
// Copy is benefit-led: lead with the operator outcome, then the feature.

import type { IconName } from "./icon";
import type { Tier } from "./tiers";

export type MarketingFeature = {
  slug: string; // url + stable key, e.g. "deposits"
  name: string; // "Deposits & no-show protection"
  tagline: string; // one line for cards / the matrix
  description: string; // 1–2 sentences for the feature page (outcome-led)
  tier: Tier; // minimum tier the feature is available at
  spec: string; // matching docs/specs file, e.g. "payments-deposits.md"
  status: "live" | "coming-soon";
  showOnHome: boolean; // surfaces in the home highlights grid
  icon: IconName; // lucide icon name (see ./icon) — typo = compile error
  // Optional deep-dive copy. `outcome` is the benefit-led headline; the
  // page falls back to `tagline` when it's absent.
  outcome?: string;
  benefits?: string[];
};

export const FEATURES: MarketingFeature[] = [
  {
    slug: "online-bookings",
    name: "Online bookings & availability",
    tagline: "Take bookings 24/7, even when the phone's ringing off the hook.",
    description:
      "Guests book a real table in seconds and the slot is held instantly — no double-bookings, no callbacks, no covers lost to a missed call.",
    tier: "free",
    spec: "bookings.md",
    status: "live",
    showOnHome: true,
    icon: "CalendarCheck",
    outcome: "Fill more tables without answering the phone",
    benefits: [
      "Real-time availability — a booked slot can't be double-sold",
      "Works while you're closed or mid-service",
      "Free for up to 50 bookings a month",
    ],
  },
  {
    slug: "booking-widget",
    name: "Embeddable booking widget",
    tagline: "Put “Book a table” on your own website in one line.",
    description:
      "A tiny, fast widget drops onto your existing site so guests book without leaving your brand — and without you paying a marketplace for your own customers.",
    tier: "free",
    spec: "widget.md",
    status: "live",
    showOnHome: false,
    icon: "Code",
    outcome: "Bookings on your site, not a marketplace",
    benefits: [
      "Under 1 KB — won't slow your page down",
      "Cookieless, with no third-party trackers",
      "Your brand, your guests, your data",
    ],
  },
  {
    slug: "guest-book",
    name: "Guest book",
    tagline: "Remember every regular and what they like.",
    description:
      "Every booking builds a guest history — visits, notes and preferences — so your team can treat a regular like a regular. Personal data is encrypted at rest.",
    tier: "free",
    spec: "guests.md",
    status: "live",
    showOnHome: false,
    icon: "Users",
    outcome: "Turn first-timers into regulars",
    benefits: [
      "Visit history and notes on every guest",
      "Encrypted personal data, consent off by default",
      "Cross-venue guest view on Plus",
    ],
  },
  {
    slug: "hosted-booking-page",
    name: "Branded booking page",
    tagline: "A beautiful booking page, no website needed.",
    description:
      "Share one link — on Instagram, Google or a QR code on the table — and guests book through a polished page with your photos, hours and reviews.",
    tier: "core",
    spec: "booking-page.md",
    status: "live",
    showOnHome: false,
    icon: "Globe",
    outcome: "A booking page that does the selling for you",
    benefits: [
      "Photos, opening hours, directions and ratings",
      "A guided party → date → time → details flow",
      "One link for socials, Google and QR codes",
    ],
  },
  {
    slug: "deposits",
    name: "Deposits & no-show protection",
    tagline: "Stop no-shows costing you covers.",
    description:
      "Take a deposit or hold a card at booking and charge automatically if a guest doesn't turn up — fewer empty tables, no awkward phone chase. Cards are handled entirely by Stripe.",
    tier: "core",
    spec: "payments-deposits.md",
    status: "live",
    showOnHome: true,
    icon: "ShieldCheck",
    outcome: "Protect your busiest tables from no-shows",
    benefits: [
      "Deposit or card-hold at the point of booking",
      "Automatic no-show capture and easy refunds",
      "PCI-safe — card data only ever touches Stripe",
    ],
  },
  {
    slug: "messaging",
    name: "Email & SMS reminders",
    tagline: "Confirmations and reminders that cut no-shows.",
    description:
      "Guests get a tidy confirmation and a timely reminder by email and SMS, so fewer forget to turn up — and fewer ring you to check the time.",
    tier: "core",
    spec: "messaging.md",
    status: "live",
    showOnHome: false,
    icon: "MessageSquare",
    outcome: "Fewer no-shows, fewer “what time were we booked?” calls",
    benefits: [
      "Automatic email + SMS confirmations and reminders",
      "SMS billed at cost — no marked-up per-message fees",
      "Branded to your venue",
    ],
  },
  {
    slug: "waitlist",
    name: "Waitlist & walk-ins",
    tagline: "Seat walk-ins and fill cancellations fast.",
    description:
      "Add walk-ins to a waitlist, notify guests the moment a table frees up, and turn a fully-booked night into a fully-seated one.",
    tier: "core",
    spec: "waitlist.md",
    status: "live",
    showOnHome: true,
    icon: "ListChecks",
    outcome: "Fill every table, even on a fully-booked night",
    benefits: [
      "Walk-in and waitlist management on one screen",
      "Auto-notify guests when a table opens up",
      "Recover covers lost to last-minute cancellations",
    ],
  },
  {
    slug: "reviews",
    name: "Reviews & reputation",
    tagline: "Win more 5-star reviews, catch problems early.",
    description:
      "Invite happy guests to review you on Google, head off unhappy ones privately, and reply from one inbox — with AI-drafted suggestions to save you time.",
    tier: "core",
    spec: "reviews.md",
    status: "live",
    showOnHome: false,
    icon: "Star",
    outcome: "A better reputation, with less effort",
    benefits: [
      "Nudge happy guests toward public reviews",
      "Catch and recover unhappy guests privately",
      "Reply from one inbox with AI-drafted replies",
    ],
  },
  {
    slug: "reporting",
    name: "Covers & no-show reporting",
    tagline: "See covers, no-shows and where bookings come from.",
    description:
      "Know your real numbers — covers served, no-show rate, deposits taken and which channels bring bookings — and export it all to CSV.",
    tier: "core",
    spec: "reporting.md",
    status: "live",
    showOnHome: false,
    icon: "ClipboardList",
    outcome: "Run the venue on numbers, not gut feel",
    benefits: [
      "Covers, no-show rate and deposit totals at a glance",
      "Booking source mix and top guests",
      "One-click CSV export",
    ],
  },
  {
    slug: "timeline",
    name: "Table timeline",
    tagline: "See the whole service on one timeline.",
    description:
      "A per-table time-block view of the night lets you spot gaps, stretch turns and reassign tables with a drag — so the floor runs smoothly.",
    tier: "core",
    spec: "timeline.md",
    status: "live",
    showOnHome: false,
    icon: "CalendarClock",
    outcome: "Run a smoother service",
    benefits: [
      "Every table and turn on one timeline",
      "Drag to reassign tables in seconds",
      "Spot gaps before they cost you covers",
    ],
  },
  {
    slug: "floor-plan",
    name: "Visual floor plan",
    tagline: "Your real room, on screen.",
    description:
      "Lay out your tables exactly as the room is, then take bookings and seat guests against a plan everyone recognises at a glance.",
    tier: "core",
    spec: "floor-plan-visual.md",
    status: "live",
    showOnHome: false,
    icon: "LayoutGrid",
    outcome: "Seat guests against the room you actually have",
    benefits: [
      "Drag-and-drop floor plan that matches your room",
      "Join tables for larger parties",
      "Live status the whole team can read",
    ],
  },
  {
    slug: "reserve-with-google",
    name: "Reserve with Google",
    tagline: "Let guests book straight from Google.",
    description:
      "Capture diners at the moment they find you — a “Reserve a table” button on your Google listing books them directly into TableKit.",
    tier: "core",
    spec: "reserve-with-google.md",
    status: "coming-soon",
    showOnHome: false,
    icon: "CalendarPlus",
    outcome: "Catch guests the moment they find you on Google",
    benefits: [
      "Book directly from your Google listing",
      "No marketplace cut on your own customers",
      "Coming soon — in partner onboarding",
    ],
  },
  {
    slug: "multi-venue",
    name: "Multi-venue management",
    tagline: "Run every site from one login.",
    description:
      "See all your venues in one overview, switch between them instantly, and share guests across the group — without juggling separate accounts.",
    tier: "plus",
    spec: "multi-venue.md",
    status: "live",
    showOnHome: true,
    icon: "Building2",
    outcome: "Run a group without the admin sprawl",
    benefits: [
      "Group overview across every venue",
      "Cross-venue guest profiles",
      "Instant ⌘K venue switching",
    ],
  },
  {
    slug: "ai-enquiry",
    name: "AI enquiry handler",
    tagline: "Turn email enquiries into bookings while you cook.",
    description:
      "Inbound enquiries are read, understood and drafted into replies automatically, so a “table for 6 on Saturday?” email becomes a booking without you stopping service.",
    tier: "plus",
    spec: "ai-enquiry.md",
    status: "live",
    showOnHome: true,
    icon: "Sparkles",
    outcome: "Never lose a booking to a slow reply",
    benefits: [
      "Reads and understands inbound enquiry emails",
      "Drafts replies for you to send — or auto-sends within guardrails",
      "Replies from your own verified sending domain",
    ],
  },
  {
    slug: "import-export",
    name: "Import & export",
    tagline: "Bring your data with you — and take it anywhere.",
    description:
      "Move off OpenTable, ResDiary or SevenRooms with a guided import, and export your bookings and guests to CSV or JSON whenever you like. Your data is yours.",
    tier: "plus",
    spec: "import-export.md",
    status: "live",
    showOnHome: false,
    icon: "ArrowLeftRight",
    outcome: "Switch without losing your history",
    benefits: [
      "Guided import from OpenTable, ResDiary and SevenRooms",
      "Bookings and guests export to CSV/JSON",
      "No lock-in — leave with your data anytime",
    ],
  },
  {
    slug: "public-api",
    name: "Public API & webhooks",
    tagline: "Wire TableKit into the rest of your stack.",
    description:
      "A clean REST API and webhooks let you connect bookings to your own tools and workflows — with proper docs and idempotency.",
    tier: "plus",
    spec: "public-api.md",
    status: "live",
    showOnHome: false,
    icon: "Webhook",
    outcome: "Connect bookings to everything else you run",
    benefits: [
      "Bearer-auth REST API at api.tablekitapp.com/v1",
      "Webhook subscriptions with replay",
      "OpenAPI 3.1 docs you can actually read",
    ],
  },
  {
    slug: "booking-insights",
    name: "Booking insights",
    tagline: "Understand how your bookings really behave.",
    description:
      "See how far ahead people book, how your no-show rate is trending and which channels perform — so you can plan staffing and deposits with confidence.",
    tier: "plus",
    spec: "booking-insights.md",
    status: "live",
    showOnHome: false,
    icon: "TrendingUp",
    outcome: "Plan with confidence, not guesswork",
    benefits: [
      "Lead-time and no-show trends over any window",
      "Per-channel performance",
      "Compare against the previous period — all CSV-exportable",
    ],
  },
  {
    slug: "service-summary",
    name: "Service summary & capacity",
    tagline: "Know if a service is over- or under-booked at a glance.",
    description:
      "A per-service view of capacity versus bookings — with a heatmap and suggestions — helps you open the right slots and avoid both empty rooms and overload.",
    tier: "plus",
    spec: "service-summary.md",
    status: "live",
    showOnHome: false,
    icon: "Gauge",
    outcome: "Right-size every service",
    benefits: [
      "Capacity vs bookings per service and day",
      "Month and week heatmaps",
      "Suggestions on where to open or hold slots",
    ],
  },
];

export const LIVE_FEATURES = FEATURES.filter((f) => f.status === "live");
export const HOME_FEATURES = FEATURES.filter((f) => f.showOnHome);

export function featureBySlug(slug: string): MarketingFeature | undefined {
  return FEATURES.find((f) => f.slug === slug);
}
