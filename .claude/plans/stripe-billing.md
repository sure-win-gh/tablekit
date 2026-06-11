# Implementation plan: Stripe subscription billing + prepaid messaging credit

**Spec:** `docs/specs/stripe-billing.md`
**Branch:** `feat/stripe-billing` (off `main`)
**Playbooks read:** `docs/playbooks/payments.md`, `docs/playbooks/gdpr.md`, `docs/playbooks/deploy.md`

## Pre-flight scope flags (the three `/plan` stop-and-ask checks)

- **PCI scope:** ✅ stays SAQ-A. Hosted Checkout + Customer Portal only — no card fields, no `pm_*` raw details on our servers. We store `stripe_customer_id`/`stripe_subscription_id` references + integer pence balances. **No expansion.**
- **New sub-processor:** none. Stripe is already approved (Connect/deposits); platform billing is the same vendor/data path. **None.**
- **Plaintext PII outside `crypto.ts`:** none. Subscription ids, status, pence balances, ledger entries are **not PII**. **No flag.**

No stop-and-ask trigger fires. Proceeding.

---

## ⚠️ Diff size → SHIP AS 3 PRs

~750–900 LOC across ~20 files. Split below; each PR independently testable & reversible.

| PR | Title | Delivers | Depends on | Est. |
|----|-------|----------|-----------|------|
| **PR-1** | Subscription billing (flat £19/£39) | Operators can subscribe to Core/Plus; plan stays in sync; dunning | — | ~340 LOC, 11 files |
| **PR-2** | Prepaid messaging credit (gates marketing) | Top-up + campaign send blocked unless balance covers estimate | PR-1 (customer + webhook infra) | ~330 LOC, 9 files |
| **PR-3** | Transactional usage meter (monthly) | Small transactional SMS/WhatsApp billed on the monthly invoice | PR-1 | ~150 LOC, 5 files |

Migration **0047** (PR-1) ships *all three* schema changes at once (`billing_subscriptions`, `billing_credit_ledger`, `organisations.credit_balance_pence`, `message_usage.reported_pence`) so PR-2/PR-3 need no migration. RLS for both new tables lands in 0047 — satisfies "RLS in the same migration as the table."

---

## PR-1 — Subscription billing (flat plan)

### Files to create
- `lib/billing/plans.ts` — env price map: `priceIdForPlan`, `planFromPriceId`, `usagePriceId()` (`STRIPE_PRICE_CORE`/`STRIPE_PRICE_PLUS`/`STRIPE_PRICE_USAGE`). Pure → unit-testable.
- `lib/billing/subscription.ts` — `syncFromSubscription(sub)`: upsert `billing_subscriptions`, map status→plan, write `organisations.plan` + `stripe_customer_id`. Only billing writer of `plan`. org resolved from `sub.metadata.organisation_id`, fallback by `stripe_customer_id`.
- `lib/billing/checkout.ts` — `createSubscriptionCheckout(orgId, targetPlan)`: lazy-ensure platform Customer (idempotency `org_<id>_billing_customer_v1`), `mode:'subscription'` with `[flat price, usage price]`, `metadata.organisation_id`, success/cancel URLs.
- `lib/billing/portal.ts` — `createPortalSession(orgId)` (guard: customer must exist).
- `lib/stripe/handlers/billing-subscription.ts` — `customer.subscription.created|updated|deleted` → sync + audit.
- `lib/stripe/handlers/billing-checkout.ts` — `checkout.session.completed` where `mode==='subscription'` → retrieve sub → sync. (Ignores `mode==='payment'` top-ups.)
- `lib/stripe/handlers/billing-invoice.ts` — `invoice.paid` (audit) / `invoice.payment_failed` (audit; banner driven by the `past_due` sub update).
- `app/(dashboard)/dashboard/organisation/billing/page.tsx` — owner-only RSC: plan, period end, cancel-at-period-end; upgrade/downgrade + "Manage billing". `requireRole('owner')`.
- `app/(dashboard)/dashboard/organisation/billing/billing-actions.ts` — `startCheckout(plan)` / `openPortal()`; `requireRole('owner')` → redirect to Stripe URL.
- `tests/unit/billing-plans.test.ts` · `tests/unit/billing-subscription.test.ts` (status→plan table incl. past_due/canceled/incomplete) · `tests/unit/billing-checkout.test.ts` (line-items/metadata/idempotency-key, lazy-customer reuse).
- `tests/integration/billing-rls.test.ts` — org A can't read org B's `billing_subscriptions` **or** `billing_credit_ledger` (both tables, since both ship in 0047).
- `tests/integration/billing-webhook.test.ts` — lifecycle `checkout.session.completed → subscription.updated(past_due) → subscription.deleted` drives `organisations.plan`; duplicate event no-ops.

### Files to modify
- `lib/db/schema.ts` — add `billingSubscriptions` + `billingCreditLedger` pgTables; add `creditBalancePence` to `organisations`; add `reportedPence` to `messageUsage`.
- `lib/stripe/handlers/index.ts` — side-effect import the three billing handlers.
- `app/(dashboard)/dashboard/organisation/page.tsx` — "Billing" link + past-due banner.
- `.env.local.example` — `STRIPE_PRICE_CORE`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_USAGE`, `NEXT_PUBLIC_APP_URL` (if absent).
- `docs/playbooks/deploy.md` — document the **platform** webhook endpoint (events `checkout.session.completed`, `customer.subscription.*`, `invoice.*`; its `whsec_*`), the dashboard Products/Prices, and the usage Meter (PR-3 needs it).

### Migration — `drizzle/migrations/0047_*.sql`
Generate table DDL with `pnpm db:generate`, then hand-append RLS/checks/triggers (generator doesn't emit those — same as 0045).

```sql
-- billing_subscriptions
CREATE TABLE "billing_subscriptions" ( ... per spec ... );--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT ..._fk FOREIGN KEY ("organisation_id")
  REFERENCES "public"."organisations"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_org_unique" ON "billing_subscriptions" ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_sub_unique" ON "billing_subscriptions" ("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_check" CHECK (plan IN ('core','plus'));--> statement-breakpoint

-- billing_credit_ledger
CREATE TABLE "billing_credit_ledger" ( ... per spec ... );--> statement-breakpoint
ALTER TABLE "billing_credit_ledger" ADD CONSTRAINT ..._fk FOREIGN KEY ("organisation_id")
  REFERENCES "public"."organisations"("id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_credit_ledger_reason_ref_unique" ON "billing_credit_ledger" ("reason","ref");--> statement-breakpoint
CREATE INDEX "billing_credit_ledger_org_idx" ON "billing_credit_ledger" ("organisation_id","created_at");--> statement-breakpoint
ALTER TABLE "billing_credit_ledger" ADD CONSTRAINT "billing_credit_ledger_reason_check"
  CHECK (reason IN ('topup','campaign_reserve','campaign_refund','adjustment'));--> statement-breakpoint

-- organisations / message_usage new columns
ALTER TABLE "organisations" ADD COLUMN "credit_balance_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_usage" ADD COLUMN "reported_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- updated_at touch on billing_subscriptions (reuse shared fn from 0045)
CREATE TRIGGER touch_billing_subscriptions_updated_at BEFORE UPDATE ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_campaigns_updated_at();--> statement-breakpoint

-- RLS: member read only; all writes via adminDb (webhook / server actions under adminDb)
ALTER TABLE "billing_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_subscriptions_member_read" ON "billing_subscriptions"
  FOR SELECT TO authenticated USING (organisation_id IN (SELECT public.user_organisation_ids()));--> statement-breakpoint
ALTER TABLE "billing_credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_credit_ledger_member_read" ON "billing_credit_ledger"
  FOR SELECT TO authenticated USING (organisation_id IN (SELECT public.user_organisation_ids()));
```

**No enforce-org trigger** on either table: `organisation_id` is the natural top-level key, written directly by adminDb — there's no parent to denormalise from (unlike `campaigns`←`venues`). Deviation from the original brief, called out.

`billing_credit_ledger` is append-only by convention; the `(reason, ref)` unique index is the idempotency guard for top-ups and reservations.

---

## PR-2 — Prepaid messaging credit (gates marketing)

### Files to create
- `lib/billing/credit.ts`:
  - `getBalance(db, orgId)` → `organisations.credit_balance_pence`.
  - `applyEntry(db, {orgId, deltaPence, reason, ref})` — **in one transaction**: `INSERT ... ON CONFLICT (reason, ref) DO NOTHING` into the ledger; if inserted, `UPDATE organisations SET credit_balance_pence = credit_balance_pence + delta` and write `balance_after`. Idempotent: a duplicate `(reason, ref)` is a no-op. Uses `SELECT ... FOR UPDATE` on the org row to serialise concurrent debits (race-free).
  - `reserveForCampaign(db, orgId, campaignId, estPence)` — `FOR UPDATE`; if `balance < est` throw `InsufficientCreditError(balance, est)`; else `applyEntry(-est, 'campaign_reserve', campaignId)`.
  - `reconcileCampaign(db, orgId, campaignId, actualPence)` — refund `reserved − actual` via `applyEntry(+diff, 'campaign_refund', campaignId)` (idempotent on the campaign id).
- `lib/billing/topup.ts` — `createTopupCheckout(orgId, amountPence)`: `mode:'payment'` Checkout, `metadata.organisation_id` + `metadata.kind='credit_topup'`, fixed-amount line item (preset £10/£20/£50). `requireRole('manager')` at the action layer.
- `lib/stripe/handlers/billing-topup.ts` — `checkout.session.completed` where `metadata.kind==='credit_topup'` → `applyEntry(+amount_total, 'topup', session.id)` + audit.
- `app/(dashboard)/dashboard/organisation/billing/topup-actions.ts` — `startTopup(amountPence)`; `requireRole('manager')`.
- `tests/unit/billing-credit.test.ts` — applyEntry idempotency on `(reason, ref)`; reserve throws when short; reconcile refund maths; concurrent-reserve serialisation (two reserves, only one fits).
- `tests/integration/billing-credit-campaign.test.ts` — launching a campaign over balance is blocked + nothing enqueues; under balance reserves, sends, and refunds the unused remainder.

### Files to modify
- `lib/stripe/handlers/index.ts` — import `./billing-topup`. (`-checkout.ts` already ignores `mode:'payment'`; `-topup.ts` ignores anything without `kind==='credit_topup'`.)
- `lib/campaigns/enqueue.ts` — before fan-out, `reserveForCampaign(orgId, campaignId, estimatedCostPence)`; surface `InsufficientCreditError` to the composer (don't enqueue).
- `lib/campaigns/dispatch.ts` — **remove** the campaign `recordUsage` (message_usage) call; on campaign completion (status→`sent`) call `reconcileCampaign` with the actual sent count × unit cost.
- `app/(dashboard)/dashboard/organisation/billing/page.tsx` — add balance + top-up buttons; usage panel now reads transactional-only (no code change to `getUsageSummary`; it just sees only transactional rows now).
- Campaign composer + actions (`app/(dashboard)/dashboard/venues/[venueId]/campaigns/*`) — show balance + estimated cost; disable Send + "top up" CTA when `balance < estimate`; map `InsufficientCreditError` to a friendly message.

**Watch:** marketing must no longer touch `message_usage` (else double-charged — prepaid *and* metered). Removing the campaign `recordUsage` call is the single point; covered by an assertion in the campaign test.

---

## PR-3 — Transactional usage meter (monthly)

### Files to create
- `lib/billing/meter-sync.ts` — `reportUsageDeltas(now)`: current-period `message_usage` rows (transactional-only after PR-2) where `est_cost_pence > reported_pence` and org has `stripe_customer_id`; `stripe.billing.meterEvents.create({event_name: STRIPE_METER_USAGE_EVENT_NAME, payload:{stripe_customer_id, value:String(delta)}, identifier:'<org>_<period>_<reported_pence>'})`; then `reported_pence = est_cost_pence`. Per-org try/catch → `{reported, skipped, failed}`.
- `app/api/cron/billing-meter-sync/route.ts` — GET, Bearer `CRON_SECRET`, `force-dynamic`+`runtime='nodejs'` (clone `campaign-tick`).
- `tests/unit/billing-meter-sync.test.ts` — delta arithmetic, idempotent identifier, skip orgs without a customer, per-org failure isolation.

### Files to modify
- `vercel.json` — `{ "path": "/api/cron/billing-meter-sync", "schedule": "40 5 * * *" }` (Pro plan → multiple crons fine).
- `.env.local.example` — `STRIPE_METER_USAGE_EVENT_NAME`.
- `docs/playbooks/deploy.md` — Meter config: `sum` aggregation; metered Price = £0.01/unit so pence-as-value bills at exact cost; record the `event_name`.

---

## Tests (consolidated)

**Unit:** plans round-trip · subscription status→plan · checkout assembly+idempotency · credit applyEntry/reserve/reconcile + concurrency · meter delta + skip/failure.
**Integration:** `billing-rls` (cross-tenant on both new tables — rule-3 proof) · `billing-webhook` (subscription lifecycle drives `plan`, idempotent) · `billing-credit-campaign` (over-balance blocks, under-balance reserves→sends→refunds).
**No e2e Playwright** — Checkout/Portal are Stripe-hosted. Manual smoke (test card 4242…) in each PR description per the payments playbook.
**Gates per PR:** `pnpm typecheck && lint && format:check && test` → `@code-reviewer` → `@gdpr-auditor`. PR-1 also: RLS test red-green (fails without the policy).

## Risks / watch-at-review

1. **Self-upgrade via success redirect** — only the webhook writes `plan`; confirm actions/page never do. (AC #2.)
2. **Double-charging marketing** — prepaid *and* metered would double-bill; PR-2 removes campaign `recordUsage`. Assert it.
3. **Credit race** — two campaigns launching at once must not both reserve past zero; `FOR UPDATE` on the org row serialises. Test it.
4. **Reservation leak** — if a campaign is cancelled/fails mid-send, `reconcileCampaign` must refund the unsent remainder (idempotent on campaign id) so credit isn't silently consumed.
5. **Top-up vs subscription session routing** — both arrive as `checkout.session.completed`; route on `mode` / `metadata.kind`. Each handler must ignore the other's sessions.
6. **Meter unit mismatch** — Price must be £0.01/unit, `sum` aggregation, or pence-as-value bills wrong. Stripe-dashboard config → go-live checklist (deploy.md), not code.
7. **Customer-id confusion** — `organisations.stripe_customer_id` (platform) vs `guests.stripe_customer_id` (connected). Different tables; comment it.
8. **Refund of unused credit on cancellation** — v1 manual (`adjustment` ledger entries); spec'd out of scope. Don't silently strand balances — surface remaining credit on the billing page.

## Rollback plan

- **Code:** revert the PR merge commit. PR-1 dormant-safe; reverting PR-2 stops top-ups + un-gates campaigns (reverts to the *old* prepaid-less behaviour — note: campaigns would then send freely again, so PR-2 revert needs care if money was at stake); reverting PR-3 stops transactional metering (usage still accrues in `message_usage`).
- **DB:** forward-only — do **not** drop `billing_subscriptions`/`billing_credit_ledger` on rollback (would orphan live Stripe subs + lose credit balances). Leaving them is harmless.
- **Kill switch:** `PAYMENTS_DISABLED=true` short-circuits the webhook route → freezes plan sync + top-up crediting instantly without deploy. Unsetting `STRIPE_PRICE_*` blocks new subscriptions/top-ups while leaving existing state intact.

## Estimated diff size

~750–900 LOC across ~20 files, split ~340 / ~330 / ~150 across PR-1/2/3. One migration (0047). Deletions limited to the campaign `recordUsage` call + index-line edits.
