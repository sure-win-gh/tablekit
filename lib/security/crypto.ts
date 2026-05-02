// Envelope encryption for PII columns.
//
// Per docs/playbooks/gdpr.md §Encryption:
//   - each organisation owns a random 32-byte DEK
//   - the DEK is wrapped with a process-wide master key (AES-256-GCM)
//     and stored in `organisations.wrapped_dek`
//   - column data is encrypted with the DEK (AES-256-GCM, 12-byte IV,
//     16-byte tag) — returned as the versioned string
//     `v1:<iv_b64>:<ct_b64>:<tag_b64>`
//   - `hashForLookup` uses HMAC-SHA256 under the master key so a lookup
//     hash is deterministic per input (enables `(org_id, email_hash)`
//     uniqueness and "find guest by email" without decrypting rows)
//
// The master key source today is `TABLEKIT_MASTER_KEY` (base64 32
// bytes). Production hardening moves this to Supabase Vault / KMS; the
// public API here does not change.
//
// This module is the *only* place that talks to the wrapped DEK column.
// Callers see orgId + plaintext / ciphertext and nothing else. The
// admin DB handle is needed because the wrapped DEK is read/written
// cross-tenant from the RLS perspective.

import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { organisations } from "@/lib/db/schema";
import { adminDb } from "@/lib/server/admin/db";

export type Plaintext = string;
export type Ciphertext = string & { readonly __brand: "Ciphertext" };

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DATA_ALGO = "aes-256-gcm";
const MASTER_ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const CURRENT_VERSION = 1;
const VERSION_PREFIX = `v${CURRENT_VERSION}`;

// -----------------------------------------------------------------------------
// Master key loading
// -----------------------------------------------------------------------------

let _masterKey: Buffer | null = null;

function masterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const raw = process.env["TABLEKIT_MASTER_KEY"];
  if (!raw) {
    throw new Error(
      "lib/security/crypto.ts: TABLEKIT_MASTER_KEY is not set. See .env.local.example.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `lib/security/crypto.ts: TABLEKIT_MASTER_KEY must decode to 32 bytes (got ${key.length}).`,
    );
  }
  _masterKey = key;
  return _masterKey;
}

// Exported only for tests — allows flipping the master between two
// known keys to prove cross-key isolation without re-importing the
// module. Also clears the per-org DEK cache and the in-flight
// provisioning map so a fresh master key is never overlaid on top of
// a DEK derived from the previous one. NOT called anywhere in
// production.
export function _resetMasterKeyForTests(): void {
  _masterKey = null;
  _dekCache.clear();
  _dekProvisioning.clear();
}

// -----------------------------------------------------------------------------
// DEK wrap / unwrap
// -----------------------------------------------------------------------------
//
// Wrapped format (bytea, fixed 60 bytes): iv(12) || tag(16) || ct(32)

function wrapDek(dek: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(MASTER_ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function unwrapDek(wrapped: Buffer): Buffer {
  if (wrapped.length !== IV_BYTES + TAG_BYTES + DEK_BYTES) {
    throw new Error("lib/security/crypto.ts: wrapped DEK has unexpected length.");
  }
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(MASTER_ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// -----------------------------------------------------------------------------
// Per-org DEK cache + lazy provisioning
// -----------------------------------------------------------------------------
//
// Concurrency model. Two layers of dedup:
//
//   1. In-process: `_dekProvisioning` holds an in-flight Promise per
//      orgId. Concurrent callers (e.g. `Promise.all([encryptPii,
//      encryptPii])` on a fresh org) all await the same Promise, so
//      only one DB round-trip and one DEK generation actually run.
//
//   2. Cross-process: the provisioning UPDATE is conditional on
//      `wrapped_dek IS NULL` and uses `RETURNING`. If we lose the
//      race against another Node instance (Vercel serverless can spin
//      up several at once on a brand-new org), the UPDATE returns
//      no rows; we re-SELECT to load whatever DEK was actually
//      persisted by the winner. Without this, two processes would
//      each generate their own DEK and the last UPDATE would clobber
//      the first — any ciphertexts encrypted with the loser's DEK
//      would then be undecryptable forever.

const _dekCache = new Map<string, Buffer>();
const _dekProvisioning = new Map<string, Promise<Buffer>>();

async function getDek(orgId: string): Promise<Buffer> {
  const cached = _dekCache.get(orgId);
  if (cached) return cached;

  const inflight = _dekProvisioning.get(orgId);
  if (inflight) return inflight;

  const promise = loadOrProvisionDek(orgId).finally(() => {
    _dekProvisioning.delete(orgId);
  });
  _dekProvisioning.set(orgId, promise);
  return promise;
}

async function loadOrProvisionDek(orgId: string): Promise<Buffer> {
  const db = adminDb();
  const [row] = await db
    .select({ wrappedDek: organisations.wrappedDek, dekVersion: organisations.dekVersion })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);

  if (!row) {
    throw new Error(`lib/security/crypto.ts: organisation ${orgId} not found.`);
  }

  if (row.wrappedDek) {
    return adoptExistingDek(orgId, row.wrappedDek, row.dekVersion);
  }

  // Lazy provisioning. Conditional UPDATE so we don't clobber a DEK
  // a sibling process wrote between our SELECT and UPDATE.
  const candidate = randomBytes(DEK_BYTES);
  const wrapped = wrapDek(candidate);
  const updated = await db
    .update(organisations)
    .set({ wrappedDek: wrapped, dekVersion: CURRENT_VERSION })
    .where(and(eq(organisations.id, orgId), isNull(organisations.wrappedDek)))
    .returning({ id: organisations.id });

  if (updated.length > 0) {
    _dekCache.set(orgId, candidate);
    return candidate;
  }

  // Lost the race: re-SELECT and adopt the winner's DEK.
  const [winner] = await db
    .select({ wrappedDek: organisations.wrappedDek, dekVersion: organisations.dekVersion })
    .from(organisations)
    .where(eq(organisations.id, orgId))
    .limit(1);
  if (!winner?.wrappedDek) {
    throw new Error(
      `lib/security/crypto.ts: organisation ${orgId} DEK provisioning lost race but no DEK present on re-read.`,
    );
  }
  return adoptExistingDek(orgId, winner.wrappedDek, winner.dekVersion);
}

function adoptExistingDek(orgId: string, wrapped: Buffer, version: number): Buffer {
  if (version !== CURRENT_VERSION) {
    throw new Error(
      `lib/security/crypto.ts: organisation ${orgId} DEK version ${version} not supported (expected ${CURRENT_VERSION}).`,
    );
  }
  const dek = unwrapDek(wrapped);
  _dekCache.set(orgId, dek);
  return dek;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function encryptPii(orgId: string, plaintext: Plaintext): Promise<Ciphertext> {
  const dek = await getDek(orgId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(DATA_ALGO, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = `${VERSION_PREFIX}:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString(
    "base64",
  )}`;
  return packed as Ciphertext;
}

export async function decryptPii(orgId: string, ciphertext: Ciphertext): Promise<Plaintext> {
  const parts = ciphertext.split(":");
  if (parts.length !== 4) {
    throw new Error("lib/security/crypto.ts: ciphertext is not in the expected v1:iv:ct:tag form.");
  }
  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (version !== VERSION_PREFIX) {
    throw new Error(
      `lib/security/crypto.ts: ciphertext version ${version} not supported (expected ${VERSION_PREFIX}).`,
    );
  }
  const dek = await getDek(orgId);
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = createDecipheriv(DATA_ALGO, dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// -----------------------------------------------------------------------------
// Deterministic lookup hash
// -----------------------------------------------------------------------------
//
// HMAC-SHA256 under the master key. Global (not per-org) so "has this
// email signed up anywhere on TableKit?" queries stay possible and so
// the simple `unique(org_id, email_hash)` index does its job.
//
// `kind` drives normalisation — callers that know they're hashing an
// email/phone get case/format folding for free. Raw callers opt out.

export type HashKind = "email" | "phone" | "raw";

function normalise(input: string, kind: HashKind): string {
  switch (kind) {
    case "email":
      return input.trim().toLowerCase();
    case "phone":
      return input.replace(/\D+/g, "");
    case "raw":
      return input;
  }
}

export function hashForLookup(input: string, kind: HashKind = "raw"): string {
  const mac = createHmac("sha256", masterKey());
  mac.update(normalise(input, kind), "utf8");
  return mac.digest("hex");
}

// -----------------------------------------------------------------------------
// Constant-time string compare — used by callers that need to compare
// two lookup hashes without leaking via timing. Safe to use elsewhere
// (active-org cookie etc. have their own).
// -----------------------------------------------------------------------------

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
