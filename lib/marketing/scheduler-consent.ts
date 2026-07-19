// Consent gate for the /demo Cal.com scheduler embed (docs/specs/demo-scheduler.md).
//
// The embed is a third-party script + iframe + cookies. We load it ONLY after
// the visitor explicitly clicks "Load scheduler" (consent-on-interaction), and
// remember that choice so a returning visitor isn't asked again. The choice is
// a client-side localStorage flag — no DB row, no PII, no RLS surface.
//
// This logic is split out of the client island so it can be unit-tested in a
// node environment (the repo has no DOM test harness): the functions take a
// Storage-like object rather than reaching for `window`, and never throw when
// storage is unavailable (Safari private mode, sandboxed iframes).

export const SCHEDULER_CONSENT_KEY = "tablekit:consent:scheduler";
export const SCHEDULER_CONSENT_VALUE = "1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** True only when a prior explicit consent is recorded. Absent/unreadable ⇒ false. */
export function readSchedulerConsent(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SCHEDULER_CONSENT_KEY) === SCHEDULER_CONSENT_VALUE;
  } catch {
    // Storage access can throw in insecure/sandboxed contexts — treat as
    // "not consented" so the embed stays gated.
    return false;
  }
}

/** Persist the consent choice. No-op (never throws) when storage is unavailable. */
export function writeSchedulerConsent(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(SCHEDULER_CONSENT_KEY, SCHEDULER_CONSENT_VALUE);
  } catch {
    // Private mode / no storage — the embed still loads for this session; we
    // just can't remember the choice for next time. Non-fatal.
  }
}
