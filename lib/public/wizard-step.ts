// Pure step logic for the conversational booking wizard (Party → Date → Time
// → Details). The current step is derived from which search params are
// present — there is no explicit ?step, so the URL can never desync from the
// rendered step. Shared by the client step components (forward nav) and the
// server orchestrator + summary trail (edit links) so both build identical
// URLs. See docs/specs/booking-page.md / the wizard plan.

export type WizardStep = "party" | "date" | "time" | "details";

export type WizardParams = {
  party?: number | undefined;
  date?: string | undefined; // YYYY-MM-DD
  month?: string | undefined; // YYYY-MM (date-step calendar browsing only)
  serviceId?: string | undefined;
  wallStart?: string | undefined; // HH:MM
};

export type RawSearchParams = {
  party?: string;
  date?: string;
  month?: string;
  serviceId?: string;
  wallStart?: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validParty(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}

export function validDate(raw: string | undefined): string | undefined {
  return raw && DATE_RE.test(raw) ? raw : undefined;
}

export function validMonth(raw: string | undefined): string | undefined {
  return raw && MONTH_RE.test(raw) ? raw : undefined;
}

// month / minMonth are "YYYY-MM"; lexicographic compare == chronological.
export function floorMonth(month: string, minMonth: string): string {
  return month < minMonth ? minMonth : month;
}

// Derive the canonical step plus the in-scope, forward-only params. Any param
// that belongs to a step later than the derived one is an orphan (a malformed
// or stale deep link) and is dropped, so the returned params are always
// self-consistent with `step`.
export function deriveStep(sp: RawSearchParams): { step: WizardStep; params: WizardParams } {
  const party = validParty(sp.party);
  const date = validDate(sp.date);
  const month = validMonth(sp.month);
  const serviceId = sp.serviceId || undefined;
  const wallStart = sp.wallStart || undefined;
  const hasSlot = Boolean(serviceId && wallStart);

  let step: WizardStep;
  if (party == null) step = "party";
  else if (date == null) step = "date";
  else if (!hasSlot) step = "time";
  else step = "details";

  const params: WizardParams = {};
  if (party != null) params.party = party;
  if (step === "date" && month) params.month = month;
  // date is non-null once step is time/details (else it'd be the date step);
  // likewise serviceId/wallStart at details (hasSlot was true).
  if (step === "time" || step === "details") params.date = date!;
  if (step === "details") {
    params.serviceId = serviceId!;
    params.wallStart = wallStart!;
  }
  return { step, params };
}

// Build a query string from the kept params (absent keys omitted). Used for
// forward navigation (client) and clear-forward edit links (server).
export function buildStepUrl(params: WizardParams): string {
  const qs = new URLSearchParams();
  if (params.party != null) qs.set("party", String(params.party));
  if (params.date) qs.set("date", params.date);
  if (params.month) qs.set("month", params.month);
  if (params.serviceId) qs.set("serviceId", params.serviceId);
  if (params.wallStart) qs.set("wallStart", params.wallStart);
  return qs.toString();
}
