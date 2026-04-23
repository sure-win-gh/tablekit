// Envelope encryption for PII columns.
//
// Per docs/playbooks/gdpr.md §Encryption:
//   - per-organisation DEK wrapped by a master key in Supabase Vault
//   - AES-256-GCM for column data
//   - email is SHA-256 hashed for lookup and stored plaintext only on
//     the venue that owns it
//
// Implementation is intentionally deferred: the key-management design
// (master key layout, per-org DEK derivation, rotation / rewrap
// semantics) needs a dedicated review before code lands. Any call
// throws so a new PII column cannot accidentally ship in plaintext.
//
// The exported types and signatures are the intended shape — schemas
// and callers can import them safely.

export type Plaintext = string;
export type Ciphertext = string & { readonly __brand: "Ciphertext" };

const pendingDesignReview = (fn: string): Error =>
  new Error(
    `lib/security/crypto.ts:${fn}: envelope encryption pending design review — ` +
      "see docs/playbooks/gdpr.md §Encryption.",
  );

export async function encryptPii(_orgId: string, _plaintext: Plaintext): Promise<Ciphertext> {
  throw pendingDesignReview("encryptPii");
}

export async function decryptPii(_orgId: string, _ciphertext: Ciphertext): Promise<Plaintext> {
  throw pendingDesignReview("decryptPii");
}

export function hashForLookup(_input: string): string {
  throw pendingDesignReview("hashForLookup");
}
