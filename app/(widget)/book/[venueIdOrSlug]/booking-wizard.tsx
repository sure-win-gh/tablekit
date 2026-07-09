// Async server orchestrator for the conversational booking flow. Derives the
// step from the URL params, loads only that step's data, and renders the step
// + progress + summary trail. Used by BOTH the hosted page and the embed so
// the flow is identical on every surface. See the wizard plan / booking-page.md.

import type { ReactNode } from "react";

import { todayInZone } from "@/lib/bookings/time";
import {
  loadPublicAvailability,
  loadPublicMonthAvailability,
  type PublicVenue,
} from "@/lib/public/venue";
import {
  addMonths,
  clampMonth,
  deriveStep,
  MAX_MONTHS_AHEAD,
  type RawSearchParams,
} from "@/lib/public/wizard-step";

import { BookingForm } from "./forms";
import { DateStep, PartyStep, TimeStep } from "./steps";
import { StepProgress, SummaryTrail } from "./summary-trail";

export async function BookingWizard({
  venue,
  basePath,
  captchaSitekey,
  sp,
}: {
  venue: PublicVenue;
  basePath: string; // e.g. /book/<slug> or /embed/<id> — for the summary edit links
  captchaSitekey: string | null;
  sp: RawSearchParams;
}) {
  const { step, params } = deriveStep(sp);
  const currentMonth = todayInZone(venue.timezone).slice(0, 7);
  const maxMonth = addMonths(currentMonth, MAX_MONTHS_AHEAD);

  // params.party!/date! are sound: deriveStep guarantees party for every
  // non-party step and date for time/details (see lib/public/wizard-step.ts).
  let effectiveStep = step;
  let body: ReactNode;

  if (step === "party") {
    body = <PartyStep />;
  } else if (step === "date") {
    // Clamp the browse month to [currentMonth, currentMonth + 12] so a crafted
    // ?month= can't push the public availability load arbitrarily far out.
    const month = clampMonth(params.month ?? currentMonth, currentMonth, maxMonth);
    const monthAvailability = await loadPublicMonthAvailability(venue, {
      month,
      partySize: params.party!,
    });
    body = (
      <DateStep
        party={params.party!}
        monthAvailability={monthAvailability}
        minMonth={currentMonth}
        maxMonth={maxMonth}
      />
    );
  } else {
    // time or details — both need the day's slots.
    const availability = await loadPublicAvailability(venue, {
      date: params.date!,
      partySize: params.party!,
    });
    const slots = availability.slots.map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      wallStart: s.wallStart,
    }));
    const picked =
      step === "details"
        ? slots.find((s) => s.serviceId === params.serviceId && s.wallStart === params.wallStart)
        : undefined;
    if (step === "details" && picked) {
      body = (
        <BookingForm
          venueId={venue.id}
          serviceId={picked.serviceId}
          date={params.date!}
          wallStart={picked.wallStart}
          partySize={params.party!}
          campaignId={params.campaign ?? null}
          captchaSitekey={captchaSitekey}
        />
      );
    } else {
      // time step, or details whose slot vanished → re-pick.
      effectiveStep = "time";
      body = <TimeStep party={params.party!} date={params.date!} slots={slots} />;
    }
  }

  return (
    <section aria-label="Book a table" className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <StepProgress step={effectiveStep} />
        <SummaryTrail
          basePath={basePath}
          step={effectiveStep}
          params={params}
          timezone={venue.timezone}
        />
      </div>
      {body}
    </section>
  );
}
