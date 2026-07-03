// bookingSpan — the timeline grid's column maths, including the
// past-midnight rollover and truncation-flag branches.

import { describe, expect, it } from "vitest";

import { bookingSpan } from "@/lib/bookings/timeline-span";

const TZ = "Europe/London";
// June 2026 = BST (UTC+1): 12:00 UTC renders as 13:00 wall time.
const at = (hhmmUtc: string) => new Date(`2026-06-15T${hhmmUtc}:00Z`);

describe("bookingSpan", () => {
  it("positions a normal in-window booking", () => {
    // 13:00–14:30 wall in a 09:00–23:00 window → slot 16, span 6.
    const s = bookingSpan(at("12:00"), at("13:30"), TZ, { startHour: 9, endHour: 23 });
    expect(s).toEqual({ startCol: 16, span: 6, truncatedEnd: false });
  });

  it("flags a same-day booking that outruns the window edge", () => {
    // 22:00–23:30 wall in a window ending 23:00 → clamped, flagged.
    const s = bookingSpan(at("21:00"), at("22:30"), TZ, { startHour: 9, endHour: 23 });
    expect(s?.truncatedEnd).toBe(true);
    expect(s?.span).toBe(4); // 22:00–23:00 clamped
  });

  it("flags a past-midnight rollover when the window ends before 24", () => {
    // 22:00–00:30 wall → end reads 30 < start 1320 → rollover; the
    // visible portion is 22:00–23:00 (window edge).
    const s = bookingSpan(at("21:00"), at("23:30"), TZ, { startHour: 9, endHour: 23 });
    expect(s).not.toBeNull();
    expect(s?.truncatedEnd).toBe(true);
    expect(s?.span).toBe(4);
  });

  it("flags a past-midnight rollover even when the window ends at 24:00", () => {
    // The regression case: clamping to 24*60 alone makes
    // endMin > winEndMin false — the rollover flag must still fire.
    const s = bookingSpan(at("22:00"), at("00:00"), TZ, { startHour: 9, endHour: 24 });
    expect(s).not.toBeNull();
    expect(s?.truncatedEnd).toBe(true);
    // Runs to the end of the day view: 23:00–24:00 wall = 4 slots.
    expect(s?.span).toBe(4);
  });

  it("does not flag a booking ending exactly at the window edge", () => {
    // 21:00–23:00 wall in a window ending 23:00 — flush, not truncated.
    const s = bookingSpan(at("20:00"), at("22:00"), TZ, { startHour: 9, endHour: 23 });
    expect(s?.truncatedEnd).toBe(false);
  });

  it("hides a zero-length booking rather than treating it as a rollover", () => {
    const s = bookingSpan(at("12:00"), at("12:00"), TZ, { startHour: 9, endHour: 23 });
    expect(s).toBeNull();
  });

  it("hides a booking entirely outside the window", () => {
    // 06:00–07:00 wall before a 09:00 window start.
    const s = bookingSpan(at("05:00"), at("06:00"), TZ, { startHour: 9, endHour: 23 });
    expect(s).toBeNull();
  });
});
