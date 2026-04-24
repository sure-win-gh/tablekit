// Time helpers for venue-local / UTC conversion.
//
// We store every booking timestamp as UTC (timestamptz). Every piece of
// display or input is a wall-clock time in the venue's IANA zone. This
// module is the one place those two worlds meet — don't reinvent the
// conversion elsewhere.

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAYS)[number];

export type VenueTimeContext = {
  timezone: string; // IANA — e.g. "Europe/London"
};

// Wall-clock "YYYY-MM-DD" + "HH:MM" in the venue's zone → UTC Date.
// Handles BST/GMT and every other IANA zone.
export function zonedWallToUtc(
  dateYMD: string,
  wallHHMM: string,
  timezone: string,
): Date {
  const [hour = "00", minute = "00"] = wallHHMM.split(":");
  return fromZonedTime(
    `${dateYMD}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`,
    timezone,
  );
}

// [startUtc, endUtc) covering the given calendar date in the venue's
// zone. Used to pull "today's bookings" and to clamp availability.
export function venueLocalDayRange(
  dateYMD: string,
  timezone: string,
): { startUtc: Date; endUtc: Date } {
  const startUtc = zonedWallToUtc(dateYMD, "00:00", timezone);
  const [yyyy = "1970", mm = "01", dd = "01"] = dateYMD.split("-");
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  d.setUTCDate(d.getUTCDate() + 1);
  const nextYmd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { startUtc, endUtc: zonedWallToUtc(nextYmd, "00:00", timezone) };
}

// Day-of-week key for a given UTC Date, in the venue's zone. A booking
// UTC-stamped at 23:30 UTC could be Tuesday or Wednesday depending on
// the zone — always read the venue's clock.
export function dayKeyInZone(instantUtc: Date, timezone: string): DayKey {
  const i = Number(formatInTimeZone(instantUtc, timezone, "i")); // 1=Mon..7=Sun
  // i=7 is Sunday in ISO; DAYS[0]=sun. Map via %7.
  return DAYS[i % 7] ?? "sun";
}

export function formatVenueTime(instantUtc: Date, ctx: VenueTimeContext): string {
  return formatInTimeZone(instantUtc, ctx.timezone, "HH:mm");
}

export function formatVenueDateLong(
  instantUtc: Date,
  ctx: VenueTimeContext,
): string {
  return formatInTimeZone(instantUtc, ctx.timezone, "EEEE d LLLL");
}

// Today in the venue's zone, as YYYY-MM-DD — for defaulting the
// bookings list to "today" on whatever server we're rendered on.
export function todayInZone(timezone: string, now: Date = new Date()): string {
  return formatInTimeZone(now, timezone, "yyyy-MM-dd");
}

// "HH:MM" → minutes-from-midnight. Pure.
export function parseWallHHMM(s: string): number {
  const [h = "0", m = "0"] = s.split(":");
  return Number(h) * 60 + Number(m);
}

// minutes-from-midnight → "HH:MM". Pure.
export function formatWallHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export { DAYS };
