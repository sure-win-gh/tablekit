// Single source of truth for plan-gated features. Maps each gated
// feature to its minimum plan tier plus the copy the paywall shows.
//
// Pure (no DB, no server-only) so both the server pages — which decide
// whether to render the LockedFeature overlay — and the client sidebar
// — which marks nav items locked — import the same map. The actual
// plan comparison is delegated to hasPlan in ./plan-level.ts.
//
// See docs/specs/plan-gating-paywall.md.

import { hasPlan, type Plan } from "./plan-level";

export type Feature =
  | "enquiries"
  | "insights"
  | "serviceSummary"
  | "crm"
  | "campaigns"
  | "apiKeys"
  | "deposits"
  | "messaging"
  | "widgetTheming";

export type FeatureMeta = {
  // Human label used in the paywall heading + plans page.
  label: string;
  // Lowest plan that unlocks the feature.
  minPlan: Plan;
  // One-line "here's what you're missing" pitch for the upgrade card.
  blurb: string;
};

export const FEATURES: Record<Feature, FeatureMeta> = {
  enquiries: {
    label: "Enquiries",
    minPlan: "plus",
    blurb: "Let AI draft replies to booking enquiries straight from your inbox.",
  },
  insights: {
    label: "Booking Insights",
    minPlan: "plus",
    blurb: "See lead-time, no-show trends and per-channel performance at a glance.",
  },
  serviceSummary: {
    label: "Service Summary",
    minPlan: "plus",
    blurb: "Capacity panel, calendar heatmap and staffing suggestions for every service.",
  },
  crm: {
    label: "Guest CRM",
    minPlan: "plus",
    blurb: "Visit history, tags and dietary notes that follow each guest across visits.",
  },
  campaigns: {
    label: "Campaigns",
    // Email broadcasts unlock at Core (with a monthly allowance); SMS/
    // WhatsApp broadcasts + audience segments are gated Plus inside the
    // feature. See docs/specs/email-broadcast-billing.md.
    minPlan: "core",
    blurb: "Broadcast events and offers to your consented guests over email, SMS and WhatsApp.",
  },
  apiKeys: {
    label: "API keys",
    minPlan: "plus",
    blurb: "Programmatic access to your bookings and guests, plus webhook subscriptions.",
  },
  deposits: {
    label: "Deposits",
    minPlan: "core",
    blurb: "Take deposits and card holds to cut no-shows on your busiest services.",
  },
  messaging: {
    label: "SMS & WhatsApp",
    minPlan: "core",
    blurb: "Send confirmations and reminders over SMS and WhatsApp, not just email.",
  },
  widgetTheming: {
    label: "Branded booking widget",
    minPlan: "plus",
    blurb: "Put your logo and brand colour on the booking page, embed and payment screen.",
  },
};

// True when `plan` is below the feature's required tier — i.e. the
// feature should render locked for this org.
export function isLocked(plan: Plan, feature: Feature): boolean {
  return !hasPlan(plan, FEATURES[feature].minPlan);
}
