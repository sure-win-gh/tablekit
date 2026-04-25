// Server-callable booking creation.
//
// `createBooking` is the only write path in this phase. It upserts the
// guest, validates the slot against live availability, inserts the
// booking + its table assignments, and emits `booking.created` to
// audit_log + booking_events.
//
// For widget-sourced bookings, if a `deposit_rules` row matches, the
// booking commits at `status: 'requested'` together with a placeholder
// `payments` row, and we hand off to `createDepositIntent` out of band
// to create the Stripe PaymentIntent. The client finishes the flow by
// confirming the returned client_secret against Stripe Elements; the
// `payment_intent.succeeded` webhook flips the booking to `confirmed`.
//
// Kept out of the server-actions file so the availability engine +
// domain invariants stay unit-testable without Next's server-action
// wiring and so the widget phase can call the same function from its
// API route.

import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { upsertGuest } from "@/lib/guests/upsert";
import { type UpsertGuestRawInput } from "@/lib/guests/schema";
import {
  bookingEvents,
  bookingTables,
  bookings,
  payments,
  services,
  venueTables,
  venues,
} from "@/lib/db/schema";
import { CardHoldIntentError, createCardHoldIntent } from "@/lib/payments/holds";
import { createDepositIntent, DepositIntentError } from "@/lib/payments/intents";
import { type DepositRule, resolveRule } from "@/lib/payments/rules";
import { audit } from "@/lib/server/admin/audit";
import { adminDb } from "@/lib/server/admin/db";
import { stripeEnabled } from "@/lib/stripe/client";
import { getAccount } from "@/lib/stripe/connect";

import { findSlots, type TableOption } from "./availability";
import { venueLocalDayRange } from "./time";

export type BookingSource = "host" | "widget" | "rwg" | "api";

export type CreateBookingInput = {
  venueId: string;
  serviceId: string;
  date: string; // YYYY-MM-DD venue-local
  wallStart: string; // "HH:MM" venue-local
  partySize: number;
  guest: UpsertGuestRawInput;
  notes?: string;
  source: BookingSource;
};

export type DepositResponse =
  | {
      kind: "payment_intent";
      clientSecret: string;
      amountMinor: number;
      // Connect Standard direct charges live on the connected account.
      // Stripe.js needs this on its instance so the Payment Element can
      // resolve the Intent — without it the Element load-errors with an
      // empty "{}" message.
      stripeAccount: string;
    }
  | {
      kind: "setup_intent";
      clientSecret: string;
      // The amount we'll capture if the booking becomes a no-show. Shown
      // in the widget so the guest knows what the card is being held
      // against — no money moves at booking time.
      amountMinor: number;
      stripeAccount: string;
    };

export type CreateBookingResult =
  | {
      ok: true;
      bookingId: string;
      guestId: string;
      guestReused: boolean;
      tableIds: string[];
      status: "confirmed" | "requested";
      deposit?: DepositResponse;
    }
  | { ok: false; reason: "guest-invalid"; issues: string[] }
  | { ok: false; reason: "slot-taken" }
  | { ok: false; reason: "no-availability" }
  | { ok: false; reason: "venue-not-found" }
  | { ok: false; reason: "deposit-failed"; bookingId: string };

// A deposit / card-hold is required only on widget-sourced bookings
// (host / api / rwg flows have no UI to collect card details on MVP),
// when Stripe is configured, when the org has a Connect account with
// charges_enabled, and when a matching `deposit_rules` row resolves
// for the booking context. The kind ('per_cover' / 'flat' / 'card_hold')
// is decided downstream — flow A (deposit) charges at booking time;
// flow B (card_hold) stores the card via SetupIntent and only captures
// on no-show.
async function resolveDepositRequirement(
  organisationId: string,
  input: CreateBookingInput,
  startAt: Date,
): Promise<{ rule: DepositRule; stripeAccountId: string } | null> {
  if (input.source !== "widget") return null;
  if (!stripeEnabled()) return null;

  const account = await getAccount(organisationId);
  if (!account || !account.chargesEnabled) return null;

  const rule = await resolveRule({
    venueId: input.venueId,
    serviceId: input.serviceId,
    partySize: input.partySize,
    at: startAt,
  });
  if (!rule) return null;

  return { rule, stripeAccountId: account.accountId };
}

export async function createBooking(
  organisationId: string,
  actorUserId: string | null,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const db = adminDb();

  // 1. Upsert the guest (validates the guest payload via Zod inside).
  const guestR = await upsertGuest(organisationId, actorUserId, input.guest);
  if (!guestR.ok) {
    return { ok: false, reason: "guest-invalid", issues: guestR.issues };
  }

  // 2. Load venue + services + tables + occupancy for the day.
  const [venue] = await db
    .select({
      id: venues.id,
      timezone: venues.timezone,
      organisationId: venues.organisationId,
    })
    .from(venues)
    .where(and(eq(venues.id, input.venueId), eq(venues.organisationId, organisationId)))
    .limit(1);
  if (!venue) return { ok: false, reason: "venue-not-found" };

  const venueServices = await db
    .select({
      id: services.id,
      name: services.name,
      schedule: services.schedule,
      turnMinutes: services.turnMinutes,
    })
    .from(services)
    .where(eq(services.venueId, venue.id));

  const venueTablesRows = await db
    .select({
      id: venueTables.id,
      areaId: venueTables.areaId,
      minCover: venueTables.minCover,
      maxCover: venueTables.maxCover,
    })
    .from(venueTables)
    .where(eq(venueTables.venueId, venue.id));

  const { startUtc, endUtc } = venueLocalDayRange(input.date, venue.timezone);
  const occupied = await db
    .select({
      tableId: bookingTables.tableId,
      startAt: bookingTables.startAt,
      endAt: bookingTables.endAt,
    })
    .from(bookingTables)
    .where(
      and(
        eq(bookingTables.venueId, venue.id),
        gte(bookingTables.startAt, startUtc),
        lt(bookingTables.startAt, endUtc),
      ),
    );

  // 3. Run availability. Must have at least one matching slot.
  const slots = findSlots({
    timezone: venue.timezone,
    date: input.date,
    partySize: input.partySize,
    services: venueServices.map((s) => ({
      id: s.id,
      name: s.name,
      schedule: s.schedule as { days: never; start: string; end: string },
      turnMinutes: s.turnMinutes,
    })),
    tables: venueTablesRows,
    occupied,
  });

  const slot = slots.find(
    (s) => s.serviceId === input.serviceId && s.wallStart === input.wallStart,
  );
  if (!slot) return { ok: false, reason: "no-availability" };

  // Pick the first option (smallest-sufficient). The UI can refine
  // later by letting the host choose, but for now "first fit" is fine.
  const option: TableOption | undefined = slot.options[0];
  if (!option) return { ok: false, reason: "no-availability" };

  // Resolve deposit requirement BEFORE the booking transaction so the
  // transaction only holds locks for the duration of DB writes — the
  // Stripe API call happens strictly outside the transaction.
  const depositReq = await resolveDepositRequirement(organisationId, input, slot.startAt);
  const initialStatus: "confirmed" | "requested" = depositReq ? "requested" : "confirmed";

  // 4. Insert the booking + its table assignments + (if a deposit is
  //    required) a placeholder `payments` row all in one transaction.
  //    The EXCLUDE constraint on booking_tables catches any concurrent
  //    booker who got there first — caught and mapped to slot-taken.
  let bookingId: string;
  let placeholderPaymentId: string | null = null;
  try {
    const txOut = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(bookings)
        .values({
          // org/venue are denormalised by the enforce_bookings trigger
          // from service_id + area_id. We pass the ids we know but the
          // trigger is the source of truth.
          organisationId,
          venueId: venue.id,
          serviceId: input.serviceId,
          areaId: option.areaId,
          guestId: guestR.guestId,
          partySize: input.partySize,
          startAt: slot.startAt,
          endAt: slot.endAt,
          status: initialStatus,
          source: input.source,
          notes: input.notes ?? null,
          bookedByUserId: actorUserId,
        })
        .returning({ id: bookings.id });
      if (!inserted) throw new Error("createBooking: insert returned no row");

      // Insert the junction rows. The exclusion constraint fires here.
      await tx.insert(bookingTables).values(
        option.tableIds.map((tableId) => ({
          bookingId: inserted.id,
          tableId,
          // These four are overwritten by the enforce_booking_tables
          // trigger from the parent booking; pass zeroes just to
          // satisfy Drizzle's NOT NULL type checks.
          organisationId,
          venueId: venue.id,
          areaId: option.areaId,
          startAt: slot.startAt,
          endAt: slot.endAt,
        })),
      );

      await tx.insert(bookingEvents).values({
        // organisation_id is overwritten by the enforce trigger.
        organisationId,
        bookingId: inserted.id,
        type: initialStatus === "confirmed" ? "status.confirmed" : "status.requested",
        actorUserId,
        meta: sql`${JSON.stringify({ tableIds: option.tableIds })}::jsonb`,
      });

      // Placeholder `payments` row with a synthetic intent id that the
      // janitor recognises. Promoted to a real pi_* after the Stripe
      // call below; left untouched (and swept by the janitor after
      // 15min) if the call fails.
      let paymentId: string | null = null;
      if (depositReq) {
        const placeholderKind = depositReq.rule.kind === "card_hold" ? "hold" : "deposit";
        const [p] = await tx
          .insert(payments)
          .values({
            organisationId,
            bookingId: inserted.id,
            kind: placeholderKind,
            stripeIntentId: `pending_${inserted.id}`,
            amountMinor: 0, // filled in once we know partySize-based total
            currency: depositReq.rule.currency,
            status: "pending_creation",
          })
          .returning({ id: payments.id });
        if (!p) throw new Error("createBooking: placeholder payment insert returned no row");
        paymentId = p.id;
      }

      return { bookingId: inserted.id, paymentId };
    });
    bookingId = txOut.bookingId;
    placeholderPaymentId = txOut.paymentId;
  } catch (err: unknown) {
    // 23P01: exclusion_violation — another booking claimed this slot.
    if (isExclusionViolation(err)) {
      return { ok: false, reason: "slot-taken" };
    }
    throw err;
  }

  await audit.log({
    organisationId,
    actorUserId,
    action: "booking.created",
    targetType: "booking",
    targetId: bookingId,
    metadata: {
      tableIds: option.tableIds,
      partySize: input.partySize,
      status: initialStatus,
      depositRequired: Boolean(depositReq),
    },
  });

  // If no deposit required, we're done — caller sees a confirmed booking.
  if (!depositReq || !placeholderPaymentId) {
    return {
      ok: true,
      bookingId,
      guestId: guestR.guestId,
      guestReused: guestR.reused,
      tableIds: option.tableIds,
      status: "confirmed",
    };
  }

  // Deposit / card-hold required. Stripe call is out-of-transaction;
  // if it fails the booking + placeholder row remain for the janitor
  // to sweep.
  const isHold = depositReq.rule.kind === "card_hold";
  try {
    if (isHold) {
      const setup = await createCardHoldIntent({
        organisationId,
        bookingId,
        paymentId: placeholderPaymentId,
        guestId: guestR.guestId,
        partySize: input.partySize,
        rule: depositReq.rule,
        stripeAccountId: depositReq.stripeAccountId,
      });
      return {
        ok: true,
        bookingId,
        guestId: guestR.guestId,
        guestReused: guestR.reused,
        tableIds: option.tableIds,
        status: "requested",
        deposit: {
          kind: "setup_intent",
          clientSecret: setup.clientSecret,
          amountMinor: setup.amountMinor,
          stripeAccount: depositReq.stripeAccountId,
        },
      };
    }
    const intent = await createDepositIntent({
      organisationId,
      bookingId,
      paymentId: placeholderPaymentId,
      guestId: guestR.guestId,
      partySize: input.partySize,
      rule: depositReq.rule,
      stripeAccountId: depositReq.stripeAccountId,
    });
    return {
      ok: true,
      bookingId,
      guestId: guestR.guestId,
      guestReused: guestR.reused,
      tableIds: option.tableIds,
      status: "requested",
      deposit: {
        kind: "payment_intent",
        clientSecret: intent.clientSecret,
        amountMinor: intent.amountMinor,
        stripeAccount: depositReq.stripeAccountId,
      },
    };
  } catch (err) {
    // Don't leak the raw error to the client — it may contain Stripe
    // diagnostic text. Audit + let the janitor handle cleanup.
    console.error("[lib/bookings/create.ts] intent creation failed:", {
      bookingId,
      paymentId: placeholderPaymentId,
      isHold,
      message:
        err instanceof DepositIntentError || err instanceof CardHoldIntentError
          ? err.message
          : String(err),
    });
    await audit.log({
      organisationId,
      actorUserId,
      action: isHold ? "stripe.setup_intent.failed" : "stripe.intent.failed",
      targetType: "payment",
      targetId: placeholderPaymentId,
      metadata: {
        bookingId,
        reason:
          err instanceof DepositIntentError || err instanceof CardHoldIntentError
            ? err.code
            : "unknown",
      },
    });
    return { ok: false, reason: "deposit-failed", bookingId };
  }
}

function isExclusionViolation(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "23P01";
}
