// Unit test for the booking_status → public webhook event mapping.
// The five public events are subscribers' contract; the test
// pins the mapping so a future schema change (new status, renamed
// event) trips this rather than silently changing what subscribers
// receive.

import { describe, expect, it } from "vitest";

import { transitionToEventType } from "@/lib/bookings/transition";

describe("transitionToEventType", () => {
  it("maps the dedicated public events", () => {
    expect(transitionToEventType("cancelled")).toBe("booking.cancelled");
    expect(transitionToEventType("seated")).toBe("booking.seated");
    expect(transitionToEventType("no_show")).toBe("booking.no_show");
  });

  it("collapses requested/confirmed/finished to booking.updated", () => {
    expect(transitionToEventType("requested")).toBe("booking.updated");
    expect(transitionToEventType("confirmed")).toBe("booking.updated");
    expect(transitionToEventType("finished")).toBe("booking.updated");
  });
});
