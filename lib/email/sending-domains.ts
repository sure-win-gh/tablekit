// Resend Domains API wrapper.
//
// Thin layer over the SDK. Keeps the rest of the codebase blind to
// Resend's exact field names and error envelope, and gives us a single
// place to sanitise errors before they bubble.
//
// We expose four operations:
//   • createDomain(name)          — POST /domains
//   • getDomain(id)               — GET  /domains/:id
//   • verifyDomain(id)            — POST /domains/:id/verify
//   • removeDomain(id)            — DELETE /domains/:id
//
// Status values are passed through verbatim; they map 1:1 to the DB
// CHECK constraint in migration 0036 (not_started | pending | verified
// | failure | temporary_failure).
//
// PII posture (per gdpr.md §Logs):
//   Domain names themselves are not PII (operator-chosen + DNS-public).
//   Resend errors can still echo arbitrary payload text on validation
//   failures — we never attach the raw SDK error as `.cause` and never
//   forward the message verbatim. The typed error in this module
//   carries only a bland code (`resend:<name>`) + the operation that
//   failed.

import "server-only";

import { resend, EmailNotConfiguredError } from "./client";

export type DnsRecord = {
  // 'SPF' | 'DKIM' | 'DMARC'. The Resend SDK types these differently
  // across releases; treat as opaque labels.
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | null;
  priority?: number | null;
  status?: string | null;
};

export type ResendDomainStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "failure"
  | "temporary_failure";

export type ResendDomainShape = {
  id: string;
  name: string;
  status: ResendDomainStatus;
  records: DnsRecord[];
};

export class SendingDomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly op: "create" | "get" | "verify" | "remove",
  ) {
    super(`${op}: ${code}`);
    this.name = "SendingDomainError";
  }
}

export type CreateResult =
  | { ok: true; domain: ResendDomainShape }
  | { ok: false; reason: "already-exists" | "invalid" | "transient" };

// Region is fixed to the EU per our sub-processor table (resend
// eu-west). All callers pass GBP-flavoured domains; if a future
// non-EU customer asks, switch to a per-org region argument.
const REGION = "eu-west-1";

export async function createDomain(name: string): Promise<CreateResult> {
  const client = resendOrConfigError();
  try {
    const r = await client.domains.create({ name, region: REGION });
    if (r.error) {
      // Resend's typed `error.name` enum doesn't currently include a
      // "domain already exists" code, but the API returns 422 with a
      // descriptive message when one collides. We sniff the human
      // message + fall back to "invalid" so the caller can show a
      // useful error.
      const code: string = r.error.name ?? "unknown";
      const msg = (r.error as { message?: string }).message ?? "";
      if (code === "validation_error" && /already.*exist|in use|duplicate/i.test(msg)) {
        return { ok: false, reason: "already-exists" };
      }
      if (code === "validation_error") return { ok: false, reason: "invalid" };
      throw new SendingDomainError(`resend:${code}`, "create");
    }
    if (!r.data) throw new SendingDomainError("resend:no-data", "create");
    return { ok: true, domain: normalise(r.data) };
  } catch (err) {
    if (err instanceof SendingDomainError) throw err;
    if (err instanceof EmailNotConfiguredError) throw err;
    // Network / SDK throw — surface as transient so the caller can
    // present "try again shortly" without claiming the domain is bad.
    return { ok: false, reason: "transient" };
  }
}

export async function getDomain(id: string): Promise<ResendDomainShape | null> {
  const client = resendOrConfigError();
  const r = await client.domains.get(id);
  if (r.error) {
    if (r.error.name === "not_found") return null;
    throw new SendingDomainError(`resend:${r.error.name ?? "unknown"}`, "get");
  }
  if (!r.data) return null;
  return normalise(r.data);
}

export async function verifyDomain(id: string): Promise<ResendDomainShape | null> {
  const client = resendOrConfigError();
  const r = await client.domains.verify(id);
  if (r.error) {
    if (r.error.name === "not_found") return null;
    throw new SendingDomainError(`resend:${r.error.name ?? "unknown"}`, "verify");
  }
  // Resend's verify response returns the updated domain envelope; some
  // SDK versions return just `{ object, id }`. Fall back to a follow-up
  // get() when records are missing so the caller always sees the full
  // shape.
  if (r.data && hasFullShape(r.data)) {
    return normalise(r.data);
  }
  return getDomain(id);
}

export async function removeDomain(id: string): Promise<void> {
  const client = resendOrConfigError();
  const r = await client.domains.remove(id);
  if (r.error && r.error.name !== "not_found") {
    throw new SendingDomainError(`resend:${r.error.name ?? "unknown"}`, "remove");
  }
}

function resendOrConfigError(): ReturnType<typeof resend> {
  return resend();
}

// Coerces the SDK's loose typing into our internal shape. Resend's
// types vary by release — accept anything that looks domain-shaped.
function normalise(raw: unknown): ResendDomainShape {
  const r = raw as Partial<ResendDomainShape> & { records?: unknown };
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    status: (r.status ?? "pending") as ResendDomainStatus,
    records: Array.isArray(r.records) ? (r.records as DnsRecord[]) : [],
  };
}

function hasFullShape(raw: unknown): boolean {
  const r = raw as { records?: unknown };
  return Array.isArray(r?.records);
}
