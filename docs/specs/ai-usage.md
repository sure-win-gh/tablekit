# Spec: AI usage ledger + monthly budget cap

**Status:** in progress
**Depends on:** `ai-enquiry.md` (the only LLM feature), `billing.md` (plan model)
**Drives:** per-org Bedrock spend visibility, tier-based hard caps

## Problem

The AI enquiry handler calls Claude Haiku on Bedrock per inbound email, but the
`usage` field on every response is discarded — no token log, no per-tenant cost
attribution, and no ceiling on monthly spend beyond a coarse 100/org/hour rate
limit. A hot inbox (or an abuse loop between two auto-responders) can run up
unbounded Bedrock cost invisible until the AWS invoice.

## Design

### Ledger: `ai_usage`

Monthly per-org, per-venue tally modelled on `message_usage`:

| column | type | notes |
|---|---|---|
| `organisation_id` | uuid FK cascade | billing identity |
| `venue_id` | uuid FK cascade | attribution within the org |
| `period` | text `yyyy-mm` (UTC) | reuses `billingPeriod()` |
| `call_count` | integer | number of Bedrock calls |
| `input_tokens` / `output_tokens` | bigint | summed from `response.usage` |

Unique on `(organisation_id, period, venue_id)`; upsert increments, exactly like
`recordUsage()`. **Cost is derived at read time** (`estAiCostPence()`), not
stored — per-call cost is a fraction of a penny (an incremented pence column
would round everything to zero) and deriving lets price-map corrections apply
retroactively.

RLS: member SELECT via `user_organisation_ids()`; no write policies — writes go
through `adminDb()` from the enquiry runner only.

Per-enquiry attribution rides the audit log (`enquiry.ai_parse` with enquiryId,
venueId, token counts) rather than a per-call table.

### Budget cap (tier-based, hard, queue-paused)

`AI_MONTHLY_BUDGET_PENCE: Record<Plan, number>` — code-defined like `FEATURES`
and `CHANNEL_COST_PENCE`. Free/Core = 0 (enquiries are Plus-gated anyway);
Plus gets a budget with ample headroom over the marketed "fair use".

Enforcement is **pre-claim** in `processEnquiry()`, beside the existing rate
limit check: over-budget orgs' enquiries stay `received` (nothing lost,
`parse_attempts` untouched), the tick skips that org so it can't starve others,
and processing resumes automatically when the period rolls over. Operator sees
a banner (see acceptance) rather than silent stalling.

## Acceptance criteria

- [ ] Every Bedrock call upserts the (org, period, venue) ledger row with real
      token counts from `response.usage`, including schema-miss responses that
      still consumed tokens.
- [ ] `enquiry.ai_parse` audit entries carry enquiryId, venueId, and token
      counts; no email content in ledger or audit metadata.
- [ ] RLS isolation test: tenant A cannot read tenant B's `ai_usage` rows.
- [ ] At budget: enquiry stays `received`, no Bedrock call, no
      `parse_attempts` bump; other orgs continue processing in the same tick.
- [ ] Period rollover resumes processing with no manual action.
- [ ] Enquiries inbox shows a paused banner when the org is over budget, with
      the resume date.
- [ ] Cost math unit-tested against the published Haiku 4.5 rate card.

## Out of scope (deliberate)

- Stripe metering/billing of AI usage (`meter-sync.ts` pattern applies later if
  we ever charge for it; the ledger already holds what it would need).
- Per-org budget overrides (additive `organisations` column when a real
  customer needs one).
- Applying the cap to any non-enquiry LLM feature — none exist.
