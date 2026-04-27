// UTC-fixed bounds helper for the admin dashboard.
//
// Distinct from lib/reports/filter.ts (venue-local timezone). Tablekit
// is UK-only today and the admin dashboard is the founder's view, so
// "today" here means today in UTC — the small skew vs Europe/London
// is acceptable for at-a-glance KPIs and avoids reasoning about a
// dashboard whose buckets shift across the BST transition.

export type Bounds = { fromUtc: Date; toUtc: Date };

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

// [start of (now - n days), now]. n=0 returns just today (start-of-day → now).
export function lastNDays(n: number, now: Date = new Date()): Bounds {
  const fromUtc = startOfUtcDay(new Date(now.getTime() - n * ONE_DAY_MS));
  return { fromUtc, toUtc: now };
}

export function todayUtc(now: Date = new Date()): Bounds {
  return { fromUtc: startOfUtcDay(now), toUtc: now };
}
