// Pure calendar-layout + heat-bucket helpers for the service-summary
// heatmap. No DB, no timezone library — these operate on YYYY-MM-DD
// strings as plain calendar dates (the venue-zone projection already
// happened when the day strings were produced), so they're trivially
// unit-testable.

export function daysInMonth(year: number, month1to12: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// Weeks for the month containing `monthFirstYMD` (its day-of-month is
// ignored — only year/month matter). Monday-start. Leading/trailing pads
// are null so the grid is always full weeks of 7.
export function monthGridDays(monthFirstYMD: string): (string | null)[][] {
  const [y = 1970, m = 1] = monthFirstYMD.split("-").map(Number);
  const total = daysInMonth(y, m);
  // getUTCDay: 0=Sun..6=Sat. Shift so Monday=0..Sunday=6.
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;

  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= total; d++) {
    cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// The Monday-start week (7 YYYY-MM-DD strings) containing `dateYMD`.
export function weekDays(dateYMD: string): string[] {
  const [y = 1970, m = 1, d = 1] = dateYMD.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const mondayOffset = (base.getUTCDay() + 6) % 7;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() - mondayOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
}

export type HeatBucket = "empty" | "low" | "mid" | "high";

// Same thresholds as the per-service utilisation bar (70 / 95%), so the
// two surfaces read consistently. Utilisation can exceed 1 (overbooked) —
// that's still "high".
export function heatBucket(utilisation: number): HeatBucket {
  if (utilisation <= 0) return "empty";
  if (utilisation < 0.7) return "low";
  if (utilisation < 0.95) return "mid";
  return "high";
}
