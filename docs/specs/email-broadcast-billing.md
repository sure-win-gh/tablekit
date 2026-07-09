# Spec: Email broadcast billing (allowance + pay-as-you-go)

**Status:** built (2026-07-07, pending PR) behind `EMAIL_OVERAGE_ENFORCED` (default off = display-only rollout step 1). Commercials: Core 500 / Plus 2,500 included; overage Core £1.00 / Plus £0.90 per 1,000 (≥30% margin over Resend's $0.80/1,000 at current FX); email-only for Core; prices ex-VAT (VAT collected at top-up — already live). Remaining: apply migration 0056, run the integration suite against a live DB, flip the flag after the 30-day notice. Note: the `List-Unsubscribe` deliverability item was already satisfied by `sendEmail`; the marketing sending subdomain is still open.
**Depends on:** `marketing-campaigns.md` (the campaign engine + prepaid credit gate), `stripe-billing.md` (credit ledger, top-ups, invariants), `plan-gating-paywall.md` (entitlements), `docs/playbooks/payments.md`

## What we're building

Today marketing **email** broadcasts are free, unmetered, and Plus-only, while SMS/WhatsApp broadcasts are prepaid at cost. As the marketing suite grows (builder, reporting — see `marketing-suite.md`), email becomes a product in its own right and carries real cost (Resend charges us $0.80 per 1,000 sends) — so we charge for it the same way we charge the other channels, with a per-plan monthly allowance. At the same time **email broadcasts open to Core** as an upgrade ladder rung.

**Model: included allowance + PAYG overage from the existing prepaid credit balance.**

| | Free | Core | Plus |
|---|---|---|---|
| Email broadcasts | — | **500 / month included** | **2,500 / month included** |
| Overage (from prepaid credit, ex-VAT) | — | **£1.00 per 1,000** (0.1p/email) | **£0.90 per 1,000** (0.09p/email) |
| Audience targeting | — | all consented guests | segments (New/Regular/Lapsed/VIP) |
| SMS / WhatsApp broadcasts | — | — (locked, upgrade prompt) | prepaid at cost (as today) |

- Overage is rounded **up** to the whole penny per campaign and drawn from the same prepaid credit balance used for SMS/WhatsApp. Calendar-month allowance (UTC, same as `billingPeriod`), no rollover.
- **Transactional email is untouched** — confirmations/reminders stay free and never blocked (same reasoning as `stripe-billing.md`: bounded by bookings, must never fail).

### Pricing rationale & unit economics

**Cost basis.** All broadcasts already go out through the **Resend transactional email API** (the campaign dispatcher reuses the shared `sendEmail` — we do NOT use Resend's per-contact Broadcasts/Audiences product, and must not: it would change the cost model from per-email to per-contact). Resend charges **$0.80 per 1,000** emails ≈ **£0.60 per 1,000** at £1 = $1.33 (July 2026).

**Margin (target ≥20–30% gross).**

| Rate (ex-VAT) | Margin @ $1.33/£ (cost 60p) | Margin @ $1.20/£ (cost 67p, weak-£ stress) |
|---|---|---|
| Plus £0.90/1,000 | **33%** | 26% |
| Core £1.00/1,000 | **40%** | 33% |

(£0.80 for Plus was considered but gives only 25% today and ~17% if the pound weakens — no buffer, rejected.) Costs are USD, prices GBP → **review rates quarterly against FX + the Resend rate card**; both live in one constant. Included-allowance sends also cost us Resend fees, but trivially: Plus 2,500 ≈ £1.50/mo against £74; Core 500 ≈ £0.30/mo against £29. Stripe top-up fees (~1.5% + 20p per Checkout) shave ~2% off net at typical top-up sizes.

**Competitive check: cheaper than everyone, but not 10× cheaper.** The competitor floor is Brevo, whose volume-based plans work out at roughly **£1.00–£1.40 per 1,000**; Mailchimp and Klaviyo (contact/profile-priced) work out at **£6+ per 1,000** for a typical venue list. Plus at £0.90 undercuts Brevo's best case; Core at £1.00 matches it while beating its typical case — and both are ~6–7× under Mailchimp/Klaviyo. The higher Core rate keeps a clean reason to upgrade beyond the bigger allowance.

### VAT

*(Flag for the accountant — this is engineering's read, not tax advice.)*

- Overage rates above are **VAT-exclusive**, consistent with plan pricing (repo rule: all prices ex-VAT, VAT added at checkout via Stripe Tax).
- **VAT is already handled**: credit top-ups run through hosted Checkout with `automatic_tax: { enabled: true }` (`lib/billing/topup.ts`), so VAT is collected when the operator buys credit. The balance is credited ex-VAT and drawdowns (campaign reserves) are internal — no further VAT event.
- VAT doesn't touch margin — it's collected from the operator and remitted; most operators are VAT-registered and reclaim it.
- One item to confirm with the accountant: prepaid messaging credit is redeemable only for standard-rated UK services, which makes it a **single-purpose voucher** (VAT due at issue, i.e. at top-up) — matching what the code already does. Confirm that treatment and the invoice wording Stripe produces.

### Deliverability note (cost-model adjacent)

Because marketing and transactional email share one Resend account/API, a venue's marketing complaints could hurt booking-confirmation deliverability. Before volume grows: send marketing from a **separate subdomain** (e.g. `mail-mkt.tablekit.uk` vs the transactional domain) with its own DKIM, and ensure campaign emails carry a **`List-Unsubscribe` header** (one-click, RFC 8058 — Gmail/Yahoo bulk-sender requirement) in addition to the footer link. Both are small dispatcher/render changes; tracked here because they protect the cost basis (staying in Resend's good graces on the transactional API).

## Why allowance + PAYG (options considered)

- *Pure PAYG from credit* — simplest, but makes every email feel like a taximeter; poor fit for the "free forever / predictable cost" brand promise.
- *Monthly add-on tiers (separate subscription item)* — predictable revenue but needs multi-item subscriptions + proration + a second dunning surface; heavy for a solo founder, and Stripe billing invariants (`organisations.plan` written only by webhook sync) get more edge cases.
- **Chosen: allowance + PAYG.** Reuses everything that already exists (credit ledger, reserve/reconcile, top-up Checkout, insufficient-credit UX). No new Stripe machinery. Most venues never leave the allowance; heavy senders self-fund via credit exactly like SMS.

## Mechanics

### 1. Entitlements are per-plan config in one place

`lib/billing/plans.ts` (or `lib/auth/entitlements.ts`) gains:

```ts
export const MARKETING_EMAIL = {
  allowancePerMonth: { free: 0, core: 500, plus: 2500 },
  overagePencePer1000: { free: 0, core: 100, plus: 90 }, // review quarterly vs FX + Resend rate card
} as const;
```

Single source; the composer, tab hints, billing page, and costing all read it.

### 2. Plan gating becomes per-channel

Campaign routes/actions currently gate `requirePlan(orgId, 'plus')` wholesale. Changes:

- **Email** campaigns (create/estimate/preview/send): `requirePlan(orgId, 'core')`.
- **SMS/WhatsApp** campaigns: `requirePlan(orgId, 'plus')` (unchanged).
- **Segments**: the audience selector is Plus-only (consistent with `guest-insights.md`); Core requests with `segment !== 'all'` are rejected server-side, and the dropdown is hidden/locked in the composer for Core.
- **Free**: no campaigns; the existing `LockedFeature` paywall stands.
- Channel tabs UI (already shipped): for Core, the SMS/WhatsApp tabs render locked with an upgrade prompt rather than hidden — visible upsell.

### 3. Consumed = counted from `campaign_sends`, not a second ledger

`message_usage` mixes transactional + campaign sends per (org, period, channel), so it can't drive the allowance. Rather than migrating a `kind` column onto the billing ledger (backfill ambiguity, drift risk), **derive marketing email consumption directly from `campaign_sends`**:

```sql
select count(*) from campaign_sends
where organisation_id = $1 and channel = 'email'
  and sent_at is not null and sent_at >= <period start> and sent_at < <period end>;
```

Count on `sent_at`, NOT `status = 'sent'` — a successful send's status advances to `delivered`/`bounced` via provider webhooks, and those sends still count (and still cost us). New partial index (forward-only migration): `campaign_sends (organisation_id, sent_at) where channel = 'email' and sent_at is not null`. Truthful by construction (the send rows ARE the sends) and no new table.

(Implementation note: `reconcileCampaign` previously counted `status = 'sent'` — fixed to `sent_at is not null` for the same reason, otherwise delivery events landing before reconcile cause over-refunds.)

Helper: `lib/billing/email-allowance.ts` → `getEmailAllowanceState(orgId, plan, now)` returning `{ allowance, used, remaining }`.

### 4. Costing — extend `estimateCostPence`, keep the reserve/reconcile invariant

`credit.ts` carries the INVARIANT that reconcile must cost actuals with the **same function** the reserve used. Email pricing is sub-penny, so per-unit `CHANNEL_COST_PENCE` can't express it. Change the costing to totals-based:

```ts
// lib/billing/usage.ts
export function estimateCampaignCostPence(
  channel: MessageChannel,
  count: number,
  opts: { plan: Plan; emailAllowanceRemaining: number }, // email-only inputs
): number {
  if (channel !== "email") return CHANNEL_COST_PENCE[channel] * Math.max(0, count);
  const chargeable = Math.max(0, count - Math.max(0, opts.emailAllowanceRemaining));
  const rate = MARKETING_EMAIL.overagePencePer1000[opts.plan];
  return Math.ceil((chargeable * rate) / 1000); // round UP to whole pence
}
```

- **Reserve** (campaign launch): snapshot `allowance_remaining_at_reserve` **and the plan's rate** onto the campaign row (two nullable int columns, forward-only migration), reserve `estimateCampaignCostPence(...)`. Two concurrent email campaigns serialise on the existing `FOR UPDATE` org row lock; the second snapshot reads the first's queued sends — acceptable approximation, reconcile trues it up.
- **Reconcile** (campaign complete): cost the actual sent count against the **same snapshots** (allowance remaining + rate at reserve — a mid-campaign plan change must not change the price), refund the difference. Same function, same base → no drift, invariant preserved.
- Zero-cost email campaigns (fully inside allowance) reserve nothing — exactly today's behaviour.

### 5. UX

- **Composer estimate line** (per-channel, in the tabbed campaigns page): `Estimated audience 3,200 · 2,500 within your monthly allowance · 700 chargeable ≈ £0.63 · credit £12.00`. Insufficient-credit path is identical to SMS today (save as draft + top-up buttons).
- **Email tab hint** becomes plan-aware: `2,500/mo included, then £0.90 per 1,000 + VAT` (from the entitlement, not hard-coded).
- **Org billing page**: allowance meter — `Marketing emails this month: 320 / 2,500` + reset date, next to the existing credit balance + usage summary.
- **Pricing page** (marketing site): Core gains "500 marketing emails/month included"; Plus gains "2,500 marketing emails/month included + audience segments + SMS/WhatsApp broadcasts"; overage rates added to the pass-through fees note.

### 6. Rollout

1. Ship counting + UI meter **display-only** (charge nothing) for one full billing period — validates the numbers against `message_usage` and Resend dashboards. Core email access can ship in this step (it's a giveaway, no notice needed).
2. Email existing Plus operators 30 days' notice of the overage pricing (T&Cs likely require notice for pricing changes — check).
3. Flip enforcement on (config flag `EMAIL_OVERAGE_ENFORCED`), reserve path goes live.
4. Watch: campaigns saved-as-draft due to insufficient credit (audit log), support volume, Core→Plus upgrades attributed to locked tabs/segments.

## Acceptance criteria

- [ ] `getEmailAllowanceState` returns correct used/remaining from `campaign_sends` across period boundaries (UTC month, matching `billingPeriod`).
- [ ] An email campaign fully within allowance reserves £0 and sends (today's behaviour preserved).
- [ ] An email campaign exceeding the allowance reserves `ceil(chargeable × rate / 1000)` at the org's plan rate; insufficient credit → draft + top-up prompt (same as SMS).
- [ ] Reconcile refunds against the same allowance + rate snapshots the reserve used — ledger sums stay exact under partial sends, retries, concurrent campaigns, and mid-campaign plan changes.
- [ ] Core can create/send email campaigns (segment forced to `all`, server-enforced); Core is blocked from SMS/WhatsApp campaigns and segment targeting; Free is blocked from all campaigns.
- [ ] Locked SMS/WhatsApp tabs render an upgrade prompt for Core.
- [ ] Transactional email is never metered against the allowance and never blocked.
- [ ] Allowance + rate figures come from `MARKETING_EMAIL` in one place; composer, tab hint, and billing page agree.
- [ ] Migration ships the partial index + snapshot columns; RLS posture unchanged (no new tables).
- [ ] Unit tests: costing rounding (0, 1, 999, 1000, 1001 chargeable at both rates), snapshot reconcile, period-boundary counting, per-channel plan gating. Integration: reserve/reconcile ledger exactness.

- [ ] Broadcasts continue to send via the transactional API (`sendEmail`); campaign emails carry a one-click `List-Unsubscribe` header; marketing sends use the dedicated marketing subdomain once configured.

## Out of scope

- Monthly add-on subscription tiers (revisit if operators ask for predictable invoicing at volume).
- Charging for transactional email.
- Free-tier email campaigns (none — decided 2026-07-07).
- Allowance rollover / annual pooling.
- Stripe metered billing of email overage (prepaid credit covers it; postpaid metering stays transactional-only).
