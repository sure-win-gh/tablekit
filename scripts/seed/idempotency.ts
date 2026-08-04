// Pure, dependency-free idempotency helpers for the seeders. Kept free of any
// `@/lib` import (crypto/adminDb pull in `server-only`, which the unit-test
// runner rejects) so this stays unit-testable on its own.

const FIRST_NAMES = [
  "Alex",
  "Priya",
  "Jamal",
  "Niamh",
  "Tom",
  "Anya",
  "Olu",
  "Iris",
  "Marco",
  "Yara",
  "Hugo",
  "Effy",
  "Sam",
  "Mei",
  "Theo",
  "Grace",
  "Daniel",
  "Leila",
  "Owen",
  "Saffron",
  "Raj",
  "Bea",
  "Callum",
  "Nadia",
  "Felix",
] as const;
const LAST_NAMES = [
  "Patel",
  "Okafor",
  "Carter",
  "Murphy",
  "Singh",
  "Williams",
  "Tanaka",
  "Hassan",
  "Romano",
  "Reid",
  "Adebayo",
  "Bennett",
  "Khan",
  "Walker",
  "Costa",
  "Fletcher",
  "Nguyen",
  "Doyle",
  "Schmidt",
  "Ali",
  "Brooks",
  "Lindqvist",
] as const;

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export type SeedGuest = { firstName: string; lastName: string; email: string; phone: string };

/**
 * Deterministic guest pool: index i always yields the same name/email/phone,
 * so re-running produces the same guest identities. Emails are unique and
 * non-deliverable (@example.invalid); an optional prefix keeps pools distinct
 * across venues sharing one database (staging) without collisions.
 */
export function buildGuestPool(size: number, prefix = ""): SeedGuest[] {
  return Array.from({ length: size }, (_, i) => {
    const firstName = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const lastName = LAST_NAMES[i % LAST_NAMES.length]!;
    const tag = prefix ? `${prefix}.` : "";
    return {
      firstName,
      lastName,
      email: `${tag}${firstName.toLowerCase()}.${lastName.toLowerCase()}.${pad(i + 1)}@example.invalid`,
      phone: `+447700${pad(900000 + i).slice(-6)}`,
    };
  });
}

/** Compare two {table: count} maps; returns the keys whose counts differ. */
export function diffRowCounts(
  before: Record<string, number>,
  after: Record<string, number>,
): Array<{ table: string; before: number; after: number }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: Array<{ table: string; before: number; after: number }> = [];
  for (const table of [...keys].sort()) {
    const b = before[table] ?? 0;
    const a = after[table] ?? 0;
    if (a !== b) diffs.push({ table, before: b, after: a });
  }
  return diffs;
}
