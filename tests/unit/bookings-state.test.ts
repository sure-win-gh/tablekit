import { describe, expect, it } from "vitest";

import {
  BOOKING_STATUSES,
  InvalidTransitionError,
  TRANSITIONS,
  assertTransition,
  canTransition,
  nextActions,
  type BookingStatus,
} from "@/lib/bookings/state";

describe("booking state machine", () => {
  it("matches the documented transition matrix exactly", () => {
    expect(TRANSITIONS).toEqual({
      requested: ["confirmed", "cancelled"],
      confirmed: ["seated", "cancelled", "no_show"],
      seated: ["finished", "cancelled"],
      finished: [],
      cancelled: [],
      no_show: [],
    });
  });

  it("enumerates every pair and agrees canTransition ↔ TRANSITIONS", () => {
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        const allowed = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
      }
    }
  });

  it("assertTransition throws InvalidTransitionError with from/to set", () => {
    try {
      assertTransition("finished", "seated");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.from).toBe<BookingStatus>("finished");
      expect(e.to).toBe<BookingStatus>("seated");
    }
  });

  it("assertTransition is a no-op on valid pairs", () => {
    expect(() => assertTransition("confirmed", "seated")).not.toThrow();
  });

  it("nextActions returns a fresh mutable copy", () => {
    const a = nextActions("confirmed");
    a.push("finished" as BookingStatus);
    expect(TRANSITIONS.confirmed).not.toContain("finished");
  });
});
