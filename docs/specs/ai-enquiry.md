# Spec: AI enquiry handler (Plus tier)

**Status:** draft — Plus tier only
**Depends on:** `bookings.md`, `messaging.md`, `guests.md`

## What we're building

An AI assistant that reads inbound enquiry emails to the venue (forwarded from their own address) and drafts a reply suggesting bookable slots, which the operator can send with one click. Optionally, auto-sends for low-risk replies.

## Why this is a Plus feature

Calls the Anthropic API, costs money per enquiry, and handles edge cases that require human review. It's a clear upsell with measurable time savings for operators who get many enquiry emails.

## User stories

- As an operator I forward (or auto-forward via a venue inbox rule) guest enquiry emails to `<venue-slug>@enquiries.tablekit.uk`.
- The AI parses the enquiry (party size, date, approximate time, special requests).
- It checks availability using our existing engine.
- It drafts a reply offering 1–3 slots, or explaining the constraint.
- I see the draft in my dashboard inbox. I click "send" or edit first.
- Optional: auto-send when confidence is high and no allergy/special-request keywords are present.

## Architecture

- Inbound emails via Resend inbound (catch-all on `enquiries.tablekit.uk`; recipient local-part = venue slug). Resend stays EU-resident; matches the existing transactional email vendor.
- Parser: Claude Haiku 4.5 served via **AWS Bedrock in `eu-west-1` (Ireland)** with In-Region inference, so guest PII never leaves the EU. Picked over the direct Anthropic API because every other PII-touching sub-processor in [gdpr.md](../playbooks/gdpr.md) is EU-resident; routing AI enquiry bodies to a US-served endpoint would have broken that posture and exposed us to Schrems-style transfer-regulation risk. Wrapped by `lib/llm/bedrock.ts` using `@anthropic-ai/bedrock-sdk` — same `messages.parse()` + `zodOutputFormat()` surface as the direct SDK. Structured outputs via Zod (model emits JSON conforming to the schema, never free text — prompt-injection defence).
- Availability: call existing internal availability API.
- Draft saved to `enquiries(id, venue_id, received_at, raw, parsed, suggested_slots, status, reply_sent_at)`.
- Reply sent via Resend using the venue's verified sending identity (not ours — prevents "via tablekit.uk" in clients).

## Prompt injection defence

Email content is untrusted. Rules:
- Parser uses tool-output structured mode, not free-form text.
- The parser's system prompt never includes instructions like "follow what the email says."
- No tool can take action based on email content alone — only draft a reply that the operator reviews.
- For auto-send mode, a separate guardrail classifier scans for injection keywords and flags for human review if hit.

## Acceptance criteria

- [ ] Parse rate >90% on a test set of 50 real-world enquiries (stripped and consented).
- [ ] p95 parse-to-draft latency <10s.
- [ ] Cost <£0.02 per enquiry (Haiku pricing buffer).
- [ ] Never sends a reply without operator approval unless auto-send mode is enabled for the venue and the enquiry passes the guardrail.
- [ ] Replies always include a human fallback line: "Not quite right? Reply and our team will help."
- [ ] Enquiry emails and drafts retained for 90 days then purged (see `gdpr.md`).

## Out of scope

- Inbound phone calls / voice AI.
- Multi-turn conversations beyond a single round-trip.
- Languages other than en-GB on first release.
