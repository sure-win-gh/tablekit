# Spec: Stripe subscription billing + prepaid messaging credit

**Status:** shipped (PR #71 — subscriptions + prepaid credit + usage meter; pricing/VAT follow-up). Test-mode Stripe resources created (Core £29 + Plus £74 prices, at-cost usage Meter + price) and wired in `.env.local`; prices are VAT-exclusive with `automatic_tax`. Remaining for live = live-mode Prices/Meter + the platform webhook endpoint — see `docs/playbooks/deploy.md`.
**Depends on:** `docs/playbooks/payments.md` (SAQ-A, idempotency, webhooks), `marketing-campaigns.md` (the campaign dispatcher this gates on credit), `messaging.md` (transactional sends, billed monthly), `auth.md` (`requireRole`, `requirePlan`, the `plan` column), `docs/playbooks/deploy.md` (new cron + env)

## What we're building

The other side of Stripe from deposits. **Deposits use Connect** — the venue is the merchant of record, guests pay the venue. **This is the opposite**: Tablekit is the merchant. Two charges:

1. **A flat monthly subscription** — £29 Core / £74 Plus, **VAT-exclusive** (VAT added at checkout via Stripe Tax) — on Tablekit's **platform** Stripe account, via hosted **Checkout** (upgrade) and **Customer Portal** (manage/cancel). Platform webhooks keep `organisations.plan` in lockstep with the live subscription, including dunning.
2. **Prepaid messaging credit** — operators **top up** a credit balance (one-off hosted Checkout payment). **Marketing campaigns are blocked unless the balance covers their estimated cost**, so a venue can never run up a large SMS/WhatsApp bill we then fail to collect. **Transactional** booking messages (confirmations/reminders) are *never* blocked — they're small, bounded by booking volume, and billed monthly at cost via a Stripe usage meter.

Card entry is **hosted Checkout / Portal only** — no card data on our servers → PCI **SAQ-A**.

### Why split marketing (prepaid) from transactional (postpaid)

Risk isn't evenly spread. A marketing blast is discretionary, operator-triggered, and can be thousands of messages in one click — that's the bill that stings if the card later declines, so it's **prepaid**. Transactional volume is capped by how many bookings a venue takes and must never fail for an empty wallet, so it stays **postpaid/monthly**.

## Platform vs Connect — keep them straight

| | Connect (existing) | Billing (this spec) |
|---|---|---|
| Merchant | the venue | Tablekit |
| Stripe Customer | `guests.stripe_customer_id` (connected account) | `organisations.stripe_customer_id` (platform account) |
| What's charged | deposits / no-show fees | £29/£74 subscription (+VAT) + credit top-ups |
| Webhook stream | Connect (`account=acct_*`) | platform (no `account`) |

`organisations.stripe_customer_id` already exists but is currently never written — this spec is its first writer.

## Design decisions & invariants

The durable record of *why* this is built the way it is, and the rules that must not be broken. Read before changing anything in `lib/billing/*` or the billing webhook handlers.

### Decisions (and the options we rejected)

1. **Two Stripe relationships, kept strictly separate.** Deposits stay on **Connect** (venue = merchant, per-guest `guests.stripe_customer_id` on the connected account). Subscriptions + credit are on the **platform** account (Tablekit = merchant, one `organisations.stripe_customer_id`). They share the webhook receiver but are distinguished by the event stream (`account=acct_*` ⇒ Connect; no `account` ⇒ platform) and by which `stripe_customer_id` column is used. *Never* conflate the two customer columns.
2. **Hosted Checkout + Customer Portal only — no embedded card collection.** This is what keeps us in PCI **SAQ-A**. Adding a Payment Element / any card field for subscriptions is a one-way door that breaks the compliance posture; forbidden without re-reading `docs/playbooks/payments.md` and an explicit decision.
3. **Usage payment model = prepaid credit that gates marketing.** Decided 2026-06-04. Rejected alternatives:
   - *Daily micro-charging of usage* — **rejected as uneconomic**: a UK card charge costs ~1.5% + 20p and Stripe won't process amounts under ~30p, so charging a few pence of SMS costs more in fees than the usage; and frequent off-session charges trigger 3-D Secure step-ups that fail off-session. Charging little-and-often makes the decline problem worse.
   - *Pure monthly postpaid for all usage* — **rejected for credit risk**: a venue can blast thousands of marketing messages in one click, then the card declines at month-end after we've already paid Twilio.
   - **Chosen:** marketing (discretionary, unbounded, operator-triggered) is **prepaid** and blocked when credit < estimate; transactional (small, bounded by bookings, must never fail) stays **postpaid/monthly** via a Stripe usage meter. See "Why split marketing" above.
4. **Stripe Products/Prices are created in the dashboard, not via API.** Their ids live in env (`STRIPE_PRICE_CORE/PLUS/USAGE`). `lib/billing/plans.ts` is the single source mapping plan↔price so Checkout and webhook reconciliation always agree.
5. **One usage meter, billed in pence.** A single Stripe Billing **Meter** with `sum` aggregation and a metered Price of **£0.01/unit**; we report `value` in **pence**, so it bills at exact pass-through cost with no markup. This is a Stripe-dashboard config dependency (in `deploy.md`), not code — get the unit wrong and it bills 100× off.
6. **Free-tier 50-bookings/month cap is deferred** — documented in `lib/auth/plan-level.ts`, still unenforced. A separate feature, deliberately out of scope here.

### Invariants (must stay true)

- **`organisations.plan` is written ONLY by `syncFromSubscription` (webhook-driven).** The Checkout success redirect must never set the plan — it only shows an "updating…" flag. This is what stops a user reaching the success URL (or replaying it) from self-upgrading without paying. *Most important rule in this feature.*
- **`past_due` keeps access; only `canceled|unpaid|incomplete_expired` drop to `free`.** `incomplete` (initial payment unconfirmed) and `paused` (recoverable — trial-without-PM / pause-collection) **leave the plan unchanged** — never silently revoke a recoverable or paying-but-paused org.
- **The dispatch registry holds ONE handler per event type.** `lib/stripe/handlers/billing-checkout.ts` is the **sole** `checkout.session.completed` handler; it routes on `mode` (subscription ⇒ sync; payment ⇒ PR-2 top-up branch). PR-2's top-up must **extend this handler**, not register the event again (a second `registerHandler` would clobber the first).
- **`billing_subscriptions` / `billing_credit_ledger` carry `organisation_id` as the natural top-level key**, written directly by adminDb in the webhook — so there is **no `enforce_*_org_id` trigger** (unlike `campaigns`←`venues`). RLS is member-read only; all writes go through adminDb.
- **Idempotency everywhere.** Webhook dedup via `stripe_events`; platform Customer creation via the deterministic key `org_<id>_billing_customer_v1` (one customer per org, ever); credit ledger via the `(reason, ref)` unique index (a top-up session / campaign reservation applies at most once).
- **Credit is reserved on campaign launch (under a `FOR UPDATE` row lock) and reconciled/refunded on completion** — so concurrent campaigns can't push the balance below zero, and the unsent remainder is returned.
- **No card data, PAN, or raw `pm_*` on our servers or in logs.** Only Stripe id references + integer pence. Audit/console lines carry ids + statuses only.

### Stripe SDK gotcha

- **`current_period_end` lives on the subscription ITEM, not the subscription top-level** (changed in the 2025 API / SDK v22). Read it from `sub.items.data[0].current_period_end`. `lib/billing/subscription.ts#periodEndOf` handles this.

## User stories

- As an **owner** on Free I click "Upgrade to Core/Plus", complete Stripe Checkout, and my org is on the new plan on return — Plus features unlock immediately.
- As an owner I open "Manage billing" → Stripe Customer Portal to change my card, switch Core↔Plus, or cancel (I keep the plan until period end, then drop to Free).
- As a manager (Plus) I **top up messaging credit** (e.g. £10/£20/£50) via Checkout; my balance goes up when payment clears.
- When I try to send a campaign, I see its estimated cost and my balance; if the balance doesn't cover it the send is **blocked** with a "top up to send" prompt. It never sends more than I've paid for.
- My booking confirmation/reminder texts always send regardless of balance, and appear on my monthly invoice at cost.
- If my **subscription** card fails, I see a billing-problem banner, Stripe retries, and terminal failure drops me to Free.

## Data model

One new subscription table + one credit ledger (forward-only migration; RLS in the same migration). None of these columns are PII.

```sql
create table billing_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organisation_id        uuid not null unique references organisations(id) on delete cascade,
  stripe_subscription_id text not null unique,
  status                 text not null,        -- Stripe sub status
  plan                   text not null check (plan in ('core','plus')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Append-only credit ledger; the running balance is denormalised onto
-- organisations and updated in the SAME transaction as each entry.
create table billing_credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  delta_pence     integer not null,            -- +top-up, −reservation, +refund
  reason          text not null check (reason in ('topup','campaign_reserve','campaign_refund','adjustment')),
  ref             text,                         -- stripe session/pi id, or campaign id — used for idempotency
  balance_after   integer not null,
  created_at      timestamptz not null default now(),
  unique (reason, ref)                          -- a top-up session / campaign reservation applies once
);
```

Reused / modified, not new:
- `organisations.stripe_customer_id` — platform Customer id (first writer is this spec).
- `organisations.credit_balance_pence integer not null default 0` — **new column**; the live balance, the single value campaign gating reads. Mutated only alongside a ledger row.
- `organisations.plan` — single source of truth the app gates on; **derived** from subscription state by the webhook, never set by the Checkout redirect.
- `message_usage` — add `reported_pence integer not null default 0` (high-water mark for the transactional meter sync). **Campaign dispatch stops writing here** (marketing is prepaid via the ledger now); `message_usage` becomes **transactional-only**.
- `stripe_events` + `registerHandler`/`dispatch` — reused verbatim for idempotency.

## API surface

**Subscription (flat plan):**
- `lib/billing/plans.ts` — env price map: `priceIdForPlan`, `planFromPriceId` (`STRIPE_PRICE_CORE`/`STRIPE_PRICE_PLUS`).
- `lib/billing/checkout.ts` — `createSubscriptionCheckout(orgId, targetPlan)`: lazy-ensure platform Customer (idempotency key `org_<id>_billing_customer_v1`), `mode:'subscription'` Checkout with the plan's flat price + a metered usage price (transactional), `metadata.organisation_id`.
- `lib/billing/portal.ts` — `createPortalSession(orgId)`.
- `lib/billing/subscription.ts` — `syncFromSubscription(sub)`: upsert `billing_subscriptions` + recompute `organisations.plan` (`active|trialing|past_due`→plan; `canceled|unpaid|incomplete_expired`→`free`; `incomplete`→unchanged). **Only** billing writer of `organisations.plan`.
- `lib/stripe/handlers/billing-subscription.ts` / `-checkout.ts` / `-invoice.ts` — `customer.subscription.*`, `checkout.session.completed` (subscription mode → sync), `invoice.paid` / `invoice.payment_failed`.

**Prepaid credit (marketing):**
- `lib/billing/credit.ts` — `getBalance(db, orgId)`; `applyEntry({orgId, deltaPence, reason, ref})` (insert ledger row + bump `credit_balance_pence` in one tx, idempotent on `(reason, ref)`); `reserveForCampaign(orgId, campaignId, estPence)` (gate: throws `InsufficientCreditError` if balance < est, else debits as `campaign_reserve` ref=campaignId); `reconcileCampaign(orgId, campaignId, actualPence)` (refund `reserved − actual` as `campaign_refund`).
- `lib/billing/topup.ts` — `createTopupCheckout(orgId, amountPence)`: `mode:'payment'` Checkout, `metadata.organisation_id` + `metadata.kind='credit_topup'`.
- `lib/stripe/handlers/billing-topup.ts` — `checkout.session.completed` with `metadata.kind==='credit_topup'` → `applyEntry(topup, ref=session.id)`. (Subscription-mode sessions ignored here; topup sessions ignored by `-checkout.ts`. Routed on `mode`/`metadata.kind`.)
- `lib/campaigns/enqueue.ts` (**modify**) — call `reserveForCampaign` before fan-out; block + surface `InsufficientCreditError` to the composer.
- `lib/campaigns/dispatch.ts` (**modify**) — **remove** the `recordUsage` (message_usage) call for campaigns; on campaign completion call `reconcileCampaign`.

**Transactional metering (monthly):**
- `lib/billing/meter-sync.ts` — `reportUsageDeltas(now)`: for current period `message_usage` rows (transactional only now) with `est_cost_pence > reported_pence` and an org `stripe_customer_id`, push a Stripe meter event valued in pence (idempotent `identifier=<org>_<period>_<reported_pence>`), set `reported_pence = est_cost_pence`. Per-org try/catch.
- `app/api/cron/billing-meter-sync/route.ts` — Bearer `CRON_SECRET`; added to `vercel.json`.

**UI:**
- `app/(dashboard)/dashboard/organisation/billing/` + `billing-actions.ts` — plan + period end + cancel-at-period-end; **credit balance + top-up buttons**; this-period transactional usage (`getUsageSummary`); upgrade/downgrade (→ Checkout) + "Manage billing" (→ Portal). `requireRole('owner')` for plan changes; top-up allowed for `requireRole('manager')`. Past-due banner on the org page.
- Campaign composer (**modify**) — show balance + estimated cost; disable "Send" + show "top up" CTA when balance < estimate.

## Acceptance criteria

- [ ] Owner can upgrade Free→Core and Free→Plus via hosted Checkout; on return the org is on the new plan and Plus gates unlock.
- [ ] `organisations.plan` is mutated **only** by `syncFromSubscription` (webhook) — hitting the success URL without the webhook does not self-upgrade.
- [ ] Cancel via Portal keeps the plan until `current_period_end`, then drops to Free; failed payment → `past_due` (banner) → recovery `active` or terminal → Free.
- [ ] A top-up payment increases `credit_balance_pence` exactly once (ledger unique on `(reason, ref)`; replayed `checkout.session.completed` is a no-op).
- [ ] A campaign **cannot enqueue/send** unless `credit_balance_pence ≥ estimated cost`; the reservation debits up front and is **race-free** (no concurrent campaign can push the balance below zero).
- [ ] On campaign completion the unused reservation (estimate − actual sent) is refunded to the balance.
- [ ] **Transactional** sends are never blocked by balance and are billed monthly via the meter; **marketing** sends never hit `message_usage`/the meter (no double-charge).
- [ ] Meter reports transactional pence exactly once per increment (delta vs `reported_pence`); re-running the cron in-period reports nothing new.
- [ ] No card/PAN/raw `pm_*` on our servers or logs — only `stripe_customer_id`/`stripe_subscription_id` references + integer pence balances.
- [ ] `billing_subscriptions` and `billing_credit_ledger` ship RLS + a cross-tenant isolation test (org A can't read org B's rows).
- [ ] Plan-change routes `requireRole('owner')`; top-up `requireRole('manager')`; all under `requirePlan` where the surface is Plus-only.

## Out of scope

- **Free-tier 50-bookings/month cap** — deferred (separate feature).
- **Auto-refund of unused prepaid credit** on cancellation — v1 is manual (`adjustment` ledger entries by founder); document the policy, don't automate.
- **Auto-recharge / low-balance auto-top-up** and balance-threshold email alerts — later; v1 is manual top-up + an in-app low-balance warning only.
- Annual plans, coupons, multi-currency (GBP only). (VAT IS handled — prices are tax-exclusive + `automatic_tax` on Checkout; tax registrations/filing are an operator/Stripe-Tax concern.)
- In-app/embedded card collection (hosted only, SAQ-A).
- Reconciling `message_usage` recorded before go-live (meter starts at go-live).
- Stripe Connect / deposits (unchanged).

---

Shipped via [PR #71](https://github.com/sure-win-gh/tablekit/pull/71): PR-1 platform-account subscriptions, PR-2 prepaid messaging credit (gates marketing), PR-3 transactional usage meter. Migration 0047. Remaining before go-live = Stripe dashboard config only (`docs/playbooks/deploy.md`).
