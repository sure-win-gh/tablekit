import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

import { UpgradeBanner } from "@/components/billing/locked-feature";
import { isLocked } from "@/lib/auth/entitlements";
import { hasPlan } from "@/lib/auth/plan-level";
import { getPlan } from "@/lib/auth/require-plan";
import { requireRole } from "@/lib/auth/require-role";
import { withUser } from "@/lib/db/client";
import { messageTemplates, venues } from "@/lib/db/schema";
import { MERGE_TAG_NAMES } from "@/lib/messaging/merge-tags";
import { templateChannels } from "@/lib/messaging/registry";
import {
  FLOW_EVENTS,
  FLOW_EVENT_TEMPLATE,
  parseBranding,
  parseMessagingSettings,
  type FlowEvent,
} from "@/lib/messaging/venue-settings";

import { MessageComposer } from "../message-composer";
import { MessagingSettingsForm, type FlowEventView } from "../messaging-form";

export const metadata = { title: "Messaging · TableKit" };

const EVENT_META: Record<
  FlowEvent,
  { label: string; help: string; timing: "before" | "after" | null }
> = {
  confirmation: {
    label: "Booking confirmation",
    help: "Sent as soon as a booking is confirmed.",
    timing: null,
  },
  reminder_24h: {
    label: "24-hour reminder",
    help: "A reminder the day before the booking.",
    timing: "before",
  },
  reminder_2h: {
    label: "2-hour reminder",
    help: "A nudge a couple of hours before arrival.",
    timing: "before",
  },
  cancelled: {
    label: "Cancellation",
    help: "Sent when a booking is cancelled.",
    timing: null,
  },
  thank_you: {
    label: "Thank-you",
    help: "Sent a few hours after the visit finishes.",
    timing: "after",
  },
};

export default async function MessagingSettingsPage({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { orgId } = await requireRole("manager");
  const orgPlan = await getPlan(orgId);
  const { venueId } = await params;

  const venue = await withUser(async (db) => {
    const rows = await db
      .select({ id: venues.id, settings: venues.settings })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    return rows[0];
  });
  if (!venue) notFound();

  const messaging = parseMessagingSettings(venue.settings);
  const branding = parseBranding(venue.settings);
  const flowEvents: FlowEventView[] = FLOW_EVENTS.map((ev) => {
    const cfg = messaging[ev];
    const meta = EVENT_META[ev];
    return {
      event: ev,
      label: meta.label,
      help: meta.help,
      capableChannels: templateChannels(FLOW_EVENT_TEMPLATE[ev]),
      timing: meta.timing,
      enabled: cfg.enabled,
      primary: cfg.channels[0] ?? "email",
      secondary: cfg.channels[1] ?? null,
      hours: cfg.hoursBeforeStart ?? cfg.hoursAfterFinish ?? null,
    };
  });
  const overrideSlots = FLOW_EVENTS.map((ev) => ({
    template: FLOW_EVENT_TEMPLATE[ev],
    label: EVENT_META[ev].label,
    channels: templateChannels(FLOW_EVENT_TEMPLATE[ev]),
  }));
  const overrideRows = await withUser(async (db) =>
    db
      .select({
        template: messageTemplates.template,
        channel: messageTemplates.channel,
        subjectOverride: messageTemplates.subjectOverride,
        bodyOverride: messageTemplates.bodyOverride,
        enabled: messageTemplates.enabled,
      })
      .from(messageTemplates)
      .where(eq(messageTemplates.venueId, venueId)),
  );

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-ink text-xl font-bold tracking-tight">Messaging</h2>
        <p className="text-ash mt-0.5 text-sm">
          Choose which messages go out, on which channels, and customise their content.
        </p>
      </div>

      <div className="border-hairline rounded-card border bg-white p-6">
        {isLocked(orgPlan, "messaging") ? <UpgradeBanner feature="messaging" /> : null}
        <MessagingSettingsForm
          venueId={venue.id}
          events={flowEvents}
          isPlus={hasPlan(orgPlan, "plus")}
          branding={{
            logoUrl: branding?.logoUrl ?? "",
            brandColour: branding?.brandColour ?? "",
            signature: branding?.signature ?? "",
            replyTo: branding?.replyTo ?? "",
            cornerStyle: branding?.cornerStyle ?? "",
          }}
        />
        <MessageComposer
          venueId={venue.id}
          slots={overrideSlots}
          overrides={overrideRows}
          mergeTags={[...MERGE_TAG_NAMES]}
        />
      </div>
    </section>
  );
}
