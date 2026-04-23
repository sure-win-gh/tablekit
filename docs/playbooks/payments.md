# Playbook: Payments & PCI

**Audience:** Claude Code and the operator.
**Read before:** touching anything in `payments.md`, webhooks, or any UI that collects card details.

## PCI scope: SAQ-A only

We use **Stripe Connect Standard**. The venue is their own Stripe account (merchant of record). Card details are entered into Stripe's hosted Elements / Payment Element. Our frontend and backend **never see raw card data**.

This keeps us in PCI **SAQ-A** scope: the smallest possible compliance footprint (~20 questions, self-assessed annually). Any design change that would expand scope is forbidden without re-reading this playbook and explicit approval.

## What is never allowed

- No raw PANs, CVVs, expiry dates, cardholder names from card, magnetic stripe or track data on our servers, logs, or databases. **Ever.**
- No proxying card data through our API routes. Use Stripe.js / Payment Element client-side tokenisation only.
- No screenshots or HAR captures containing card fields included in bug reports or Sentry events.
- No storing Stripe publishable keys in source (public is fine to bundle; secret goes in env only).
- No customer card tokens in our database except Stripe's `payment_method_id` reference — never the raw details.

## What we do store

- `stripe_accounts`: the Connected Account ID (`acct_...`) per organisation.
- `payments`: Stripe PaymentIntent ID (`pi_...`), status, amounts.
- `stripe_events`: raw event envelopes from Stripe (for idempotency; no card data is present in these events).

All amounts are in minor units (pence). Never floats.

## Payment flows (see `payments.md` spec for full detail)

1. **Deposit required** — `PaymentIntent` with `capture_method: automatic`, charged at booking time.
2. **Card hold / no-show fee** — `SetupIntent` at booking, stored `payment_method_id`, charged via `PaymentIntent` with `off_session: true` only if no-show rule fires.
3. **No deposit** — no Stripe involvement at all.

3D Secure is forced (`request_three_d_secure: 'any'`). We do not disable SCA even for low-value amounts, even for returning customers.

## Webhooks

- Endpoint: `app/api/stripe/webhook/route.ts`.
- Verify signature using `STRIPE_WEBHOOK_SECRET`. Reject with 400 on any verification failure.
- **Idempotency:** every event written to `stripe_events(id pk, type, received_at, handled_at, payload)`. Handler is a no-op if `id` already exists.
- Handle: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `account.updated`.
- Retries: Stripe retries up to 3 days. Our handler must be idempotent and fast (<5s).

## Refunds

- Refunds triggered from dashboard only (not from automated flows).
- Full refund = cancel within the deposit window (from `deposit_rules.refund_window_hours`).
- Partial refund = manual operator action with reason captured.
- Refunds are logged in `audit_log` with `user_id` of the operator who initiated them.

## Connect onboarding

- Use Stripe's Express or Standard hosted onboarding flow. Do not collect KYC data ourselves.
- Venues are blocked from taking payments until `charges_enabled: true` on the connected account.
- We don't platform fees on MVP — Stripe's standard rate passes through, we take our subscription fee separately.

## Testing

- Test mode uses Stripe's published test cards. Record them in `tests/payments/fixtures.ts`, don't invent new ones.
- E2E Playwright tests hit a dedicated test Stripe account, never the live account.
- Never use real cards in development. Use 4242 4242 4242 4242 etc.

## If you are unsure

If a feature request touches cards in any way that isn't on the list above, **stop and ask** before implementing. Expanding PCI scope beyond SAQ-A is a one-way door and directly undermines the whole commercial proposition.

## Annual tasks

- Renew SAQ-A self-assessment (calendar reminder).
- Review Stripe's compliance requirements for any changes.
- Confirm no logs or backups captured card data (spot check Sentry events, app logs).
- Rotate webhook secret if there's any suspicion of exposure.
