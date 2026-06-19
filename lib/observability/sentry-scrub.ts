// Shared PII scrubbing for telemetry, per docs/playbooks/gdpr.md ("Logs and
// error tracking"): strip `email`, `phone`, `last_name`, `dob`, `notes` (and
// obvious variants) from anything we send to Sentry.
//
// Two surfaces use this:
//   • the Sentry `beforeSend` hook — `scrubEvent` walks the whole event
//     (extra, contexts, request, breadcrumbs, …) as a last line of defence;
//   • lib/observability/capture.ts — `redactContext` scrubs the flat
//     structured context it attaches before it ever reaches the SDK.
//
// Keys are matched case-insensitively, ignoring separators, so `last_name`,
// `lastName` and `lastname` all hit. We deliberately do NOT scrub a bare
// `name` in the recursive event walk: Sentry's own metadata (os.name,
// sdk.name, runtime.name) uses it and redacting those would corrupt event
// grouping. App PII always travels under a qualified key (`last_name`,
// `first_name`, `full_name`, `guest_name`), all of which are covered.

const REDACTED = "[redacted]";

// Canonical, separator-free key forms that must never leave the process.
const EVENT_PII_KEYS: ReadonlySet<string> = new Set([
  "email",
  "phone",
  "phonenumber",
  "lastname",
  "firstname",
  "fullname",
  "guestname",
  "surname",
  "dob",
  "dateofbirth",
  "notes",
]);

// The flat context we attach ourselves is always our own keys (never Sentry
// metadata), so we can additionally redact a bare `name` there without risk.
const CONTEXT_PII_KEYS: ReadonlySet<string> = new Set([...EVENT_PII_KEYS, "name"]);

function canonical(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

/**
 * Redact a single-level context bag (the `extra` we attach in capture.ts and
 * the same object logged to the console fallback). Returns a new object;
 * never mutates the input.
 */
export function redactContext(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    out[k] = CONTEXT_PII_KEYS.has(canonical(k)) ? REDACTED : v;
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Recursively redact any value held under a PII-named key. Used by the Sentry
 * `beforeSend` hook over an arbitrary event payload. Returns a scrubbed copy,
 * never throws, and bottoms out at MAX_DEPTH so a cyclic or pathologically
 * deep structure can't stall the SDK's send path.
 */
export function scrubEvent<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubEvent(item, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = EVENT_PII_KEYS.has(canonical(k)) ? REDACTED : scrubEvent(v, depth + 1);
  }
  return out as T;
}
