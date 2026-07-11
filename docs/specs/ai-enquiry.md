# Spec: AI enquiry handler (Plus tier)

**Status:** shipped — Plus tier only
**Depends on:** `bookings.md`, `messaging.md`, `guests.md`

## What we're building

An AI assistant that reads inbound enquiry emails to the venue (forwarded from their own address) and drafts a reply suggesting bookable slots, which the operator can send with one click. Optionally, auto-sends for low-risk replies.

## Why this is a Plus feature

Calls the Anthropic API, costs money per enquiry, and handles edge cases that require human review. It's a clear upsell with measurable time savings for operators who get many enquiry emails.

## User stories

- As an operator I forward (or auto-forward via a venue inbox rule) guest enquiry emails to `<venue-slug>@enquiries.tablekitapp.com`.
- The AI parses the enquiry (party size, date, approximate time, special requests).
- It checks availability using our existing engine.
- It drafts a reply offering 1–3 slots, or explaining the constraint.
- I see the draft in my dashboard inbox. I click "send" or edit first.
- Optional: auto-send when confidence is high and no allergy/special-request keywords are present.

## Architecture

- Inbound emails via Resend inbound (catch-all on `enquiries.tablekitapp.com`; recipient local-part = venue slug). Resend stays EU-resident; matches the existing transactional email vendor.
- Parser: Claude Haiku 4.5 served via **AWS Bedrock in `eu-west-1` (Ireland)** with In-Region inference, so guest PII never leaves the EU. Picked over the direct Anthropic API because every other PII-touching sub-processor in [gdpr.md](../playbooks/gdpr.md) is EU-resident; routing AI enquiry bodies to a US-served endpoint would have broken that posture and exposed us to Schrems-style transfer-regulation risk. Wrapped by `lib/llm/bedrock.ts` using `@anthropic-ai/bedrock-sdk` — same `messages.parse()` + `zodOutputFormat()` surface as the direct SDK. Structured outputs via Zod (model emits JSON conforming to the schema, never free text — prompt-injection defence).
- Availability: call existing internal availability API.
- Draft saved to `enquiries(id, venue_id, received_at, raw, parsed, suggested_slots, status, reply_sent_at)`.
- Reply sent via Resend using the venue's verified sending identity (not ours — prevents "via tablekitapp.com" in clients).

## Model choice (Haiku 4.5 vs alternatives)

We pinned to Claude Haiku 4.5 on AWS Bedrock `eu-west-1`. Recording the rationale here so future-us doesn't relitigate when cost comes up again.

- **Cost ceiling is loose.** Haiku 4.5 runs ~£0.001 per enquiry → ~£1/month at upper-bound Plus-tier volumes (1000 enquiries) vs £74/month revenue. Gemini Flash 2.5 (~£0.0004) saves ~50p/month per heavy user. Immaterial against the price the customer pays.
- **Residency is the binding constraint.** Anthropic-on-Bedrock-EU keeps PII in Ireland. Vertex AI Gemini in `europe-west1` (Belgium) would also work, but adds Google Cloud as a brand-new sub-processor (separate from the existing Google Business Profile relationship — different DPA, different processing) and triggers the 30-day customer-notice cycle for a second time after we just resolved this.
- **Vendor minimalism.** AWS is already entering the sub-processor table for this feature. Adding Google Cloud alongside compounds vendor sprawl with no offsetting benefit.
- **Model-swap cost.** Per [gdpr.md](../playbooks/gdpr.md) §Reviewing changes that touch PII rule 8, an LLM model ID bump is a sub-processor-equivalent change — half a day of code work plus a fresh `/audit gdpr`. Doable any time; not worth it for ~50p/month.
- **Quality is a wash.** Haiku 4.5 has a marginal edge on reasoning depth (useful for ambiguous "next Friday-ish" date phrasing); Flash 2.5 is also strong. Probably indistinguishable on this workload.

**Revisit triggers** — reopen this decision if:

1. Enquiry volume crosses ~100k/month and the cost line item shows up in the P&L.
2. Anthropic raises Haiku pricing materially or retires the model.
3. We start using the LLM for non-PII tasks (suggestion engines, reporting summaries) where the residency constraint relaxes — at that point we may want a non-Bedrock provider for the non-PII workload while keeping Haiku-on-Bedrock for enquiries.

## Prompt injection defence

Email content is untrusted. Rules:
- Parser uses tool-output structured mode, not free-form text.
- The parser's system prompt never includes instructions like "follow what the email says."
- No tool can take action based on email content alone — only draft a reply that the operator reviews.
- For auto-send mode, a separate guardrail classifier scans for injection keywords and flags for human review if hit.

## Acceptance criteria

- [ ] Parse rate >90% on a test set of 50 real-world enquiries (stripped and consented). Tracked as a manual launch-readiness check — not codified in CI.
- [ ] p95 parse-to-draft latency <10s. Observed via Bedrock telemetry; not in CI.
- [ ] Cost <£0.02 per enquiry (Haiku pricing buffer). Tracked in `lib/llm/bedrock.ts` per-call telemetry; spot-checks against monthly Bedrock invoices.
- [x] Never sends a reply without operator approval unless auto-send mode is enabled for the venue AND the enquiry passes the guardrail. Auto-send wired in [`lib/enquiries/runner.ts`](../../lib/enquiries/runner.ts) → `attemptAutoSend`. Guardrail at [`lib/enquiries/guardrail.ts`](../../lib/enquiries/guardrail.ts) holds on: no slots, any `specialRequests` (Article-9 surface), body >2000 chars, reply-chain markers, prompt-injection keywords. Per-venue toggle at `venue.settings.aiEnquiryAutoSendEnabled` (default false). Audit: `enquiry.auto_sent` on success, `enquiry.auto_sent_held` with reason on guard miss.
- [x] Replies always include a human fallback line. Baked into [`lib/enquiries/draft.ts`](../../lib/enquiries/draft.ts) — every generated draft (whether operator-sent or auto-sent) ends with "Not quite right? Reply to this email and our team will help."
- [x] Enquiry emails and drafts retained for 90 days then purged. [`lib/enquiries/retention.ts`](../../lib/enquiries/retention.ts) sweep + `/api/cron/enquiry-retention` daily cron; audit `enquiry.retention.swept`.

## Out of scope

- Inbound phone calls / voice AI.
- Multi-turn conversations beyond a single round-trip.
- Languages other than en-GB on first release.

## Sending identity

Replies go from the venue's verified domain when one is registered + verified, otherwise from the platform default. Resolution lives in [`lib/enquiries/send-reply.ts`](../../lib/enquiries/send-reply.ts) → `resolveFromAddress(venueId)` and is called by both the operator-action send path and the runner's auto-send path. Fallback is permissive: a missing row, a non-`verified` status, or a venue without a slug all fall through to `fromEmail()` — a half-set-up domain must never drop replies on the floor.

Setup UI lives at `/dashboard/venues/[venueId]/settings` — owner adds a domain, sees the DKIM/SPF/DMARC records Resend issued, pastes them into DNS, clicks "Verify now", and watches the status badge flip. Backed by `venue_sending_domains` (migration 0036, RLS-tested) and the Resend wrapper at [`lib/email/sending-domains.ts`](../../lib/email/sending-domains.ts).

## Verification polling

A daily sweep at `/api/cron/sending-domain-verify` (`50 4 * * *`) re-checks any `venue_sending_domains` row still in `pending` / `not_started` / `temporary_failure` and younger than 14 days, calling Resend's verify endpoint per row. Newly-verified rows get `verifiedAt` stamped + an `enquiry.sending_domain.verified` audit entry tagged `source: "cron"`. The 14-day cap stops the cron from hammering dead rows; the manual "Verify now" button on the settings page still works for older rows and for the impatient case.

Capped at 100 rows per run so a backlog doesn't fan out a Resend-API burst. Per-row errors are sanitised + swallowed (the wrapper already strips PII-shaped messages, but defence in depth) so a single bad row doesn't block the rest of the sweep.
