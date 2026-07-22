// A bookable day for the e2e specs, computed rather than hard-coded.
//
// Both the widget and bookings specs used fixed dates ("2026-07-12",
// "2026-06-15") that silently fell into the past, at which point the venue
// offers no slots and every downstream step times out on a control that was
// never going to render. Deriving the day from "now" keeps them honest.
//
// The seeded services in those specs run every day, so any near-future day
// works; ten days out stays clear of today/tomorrow edge cases.

const VENUE_TZ = "Europe/London";

export type BookingDay = {
  /** YYYY-MM-DD, for date inputs. */
  iso: string;
  year: number;
  month: number;
  day: number;
  /** Calendar months between today and the target — 0 or 1 here. */
  monthsAhead: number;
};

export function bookingDay(daysAhead = 10): BookingDay {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VENUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const now = (type: string) => Number(parts.find((p) => p.type === type)!.value);

  // UTC purely as calendar arithmetic, then read the date back out.
  const today = Date.UTC(now("year"), now("month") - 1, now("day"));
  const target = new Date(today + daysAhead * 24 * 60 * 60 * 1000);

  const year = target.getUTCFullYear();
  const month = target.getUTCMonth() + 1;
  const day = target.getUTCDate();

  return {
    iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
    monthsAhead: year * 12 + month - (now("year") * 12 + now("month")),
  };
}
