# Spec: Marketing suite — email builder + campaign reporting

**Status:** Phases A + B built (2026-07-07, pending PR). Phase A: block schema (`lib/campaigns/blocks.ts`), `campaigns.body_doc` (migration 0057), doc renderer with inline **bold**/*italic*/[links] + plain-text part, builder UI, `campaign-assets` bucket + upload action, test-send-to-self (uncounted). Phase B: `bookings.campaign_id`/`attribution_kind` (migration 0058), `tk_c` link attribution end-to-end (renderer appends to booking-surface links on real sends only → wizard URL contract carries it → API verifies campaign belongs to (venue, org) before stamping `link`), click-window fallback cron (`/api/cron/campaign-attribution`, 7-day window, link never overwritten), and the per-campaign report page (delivery/engagement Core+, bookings/covers/deposits funnel Plus with the MPP opens caveat). Phase C (partial): **bookingCta** block (URL built by the renderer from the venue's booking page + party/date prefill — operator never types a URL; auto-attribution), **countdown** block backed by a self-hosted signed-token image endpoint (`/api/countdown/[token]`, dependency-free GIF89a encoder + 5×7 bitmap font, single frame rendered at request time, `private, max-age=60`, "IT'S ON!" after target, no guest identifiers in the token), and **social** block (explicit operator URLs — venue settings has no socials slice yet). Deviations: countdown is a per-open static frame, not an animated GIF (animation = follow-up; keeps the image ~30 KB); `eventCard` dropped as redundant (composable from image+heading+bookingCta); `columns` deferred (email-safe 2-col + mobile stacking not worth the complexity yet); EXIF strip/re-encode deferred (no image lib — bucket MIME allowlist + 2 MB cap enforced); `List-Unsubscribe` already stamped by `sendEmail`. **Templates (2026-07-07, built):** `campaign_templates` table (org-scoped, member-read RLS, adminDb-only writes — migration 0059 + `rls-campaign-templates.test.ts` isolation test, 20/org cap), save-current-design + delete actions (audited), and a "Start from" picker in the builder combining org templates with four **code-defined starters** (event announcement, new menu, quiet-night offer, newsletter) — starters version with the codebase, carry themes + merge tags + a bookingCta each, and are schema-validated by a unit test so a block-schema change can never ship a broken starter. Applying a template loads its theme, blocks and subject into the builder/live preview. Stored docs are re-validated on read.

**Banner + footer (2026-07-07, built):** builder emails no longer render the logo + venue-name header (transactional emails keep it — guests must recognise booking emails). Instead the theme carries an optional **banner** image (uploaded via `campaign-assets`; UI guidance: 1120×380px ≈ 3:1, displays at 560px so 2× width for retina, JPEG/WebP, ~200 KB target / 2 MB cap; optional link participates in tk_c attribution) and **footer text** (≤500 chars, merge tags OK, address/contact/hours) rendered above the unavoidable unsubscribe line. `EmailLayout` gained `showVenueHeader` + `footerNote` props (defaults preserve transactional behaviour).

**Custom HTML / Canva:** scoped separately in [`custom-email-html.md`](custom-email-html.md).

**Still open from Phase C:** link-level clicks (`campaign_link_clicks`), the 90-day marketing overview page.

**Builder UX + customisation (2026-07-07, post-Phase-C):** Kit-style editing — split-pane layout with a debounced live preview (the real renderer, desktop/phone toggle), HTML5 drag-drop from the palette + grip-handle reordering with animated drop indicators (arrow buttons kept for keyboard/touch). **Theme layer**: optional `theme` on the doc (curated email-safe font stacks, hex-only accent/text colours, button shape square/rounded/pill) + per-block overrides (colour/size/align on heading/text/button/bookingCta, divider colour). Precedence: block → theme → venue brand colour → default; all additive optional fields, no doc version bump; colours are strict 6-digit hex (CSS-injection test in `campaign-theme.test.ts`). Deliberately excluded: custom uploaded fonts, dark-mode variants, gradients (hostile email-client support).
**Depends on:** `marketing-campaigns.md` (campaign engine, dispatch, Resend webhook), `email-broadcast-billing.md` (allowance + PAYG — ship billing first or together, so the suite launches already monetised), `message-customisation.md` (branding, merge tags), `guest-insights.md` (segments), `widget.md` / `booking-page.md` (attribution touchpoint), `docs/playbooks/gdpr.md`

## What we're building

Turn the plain-text campaign composer into a proper email marketing suite: a **block-based email builder** (images, buttons, dividers, countdowns, booking CTAs) and **campaign reporting** that goes past opens/clicks to the metric none of the horizontal ESPs can show — **bookings and covers attributed to the campaign**.

### Tier gating (decided 2026-07-07)

Email broadcasts are Core+ per `email-broadcast-billing.md`. Within the suite:

- **Core:** the block builder, templates, test-send, and basic per-campaign stats (sent / delivered / opened / clicked on the campaign list + a simple campaign detail view).
- **Plus:** everything in Core **plus** booking/covers/deposit **attribution**, the full per-campaign funnel report, and the marketing overview dashboard — the headline upsell ("see which emails filled tables").
- Attribution data is still *collected* for Core campaigns (the `tk_c` param costs nothing to stamp) so the funnel back-fills the moment they upgrade — the report pages are what's gated, not the capture.

## Competitive research (July 2026)

What the incumbents offer, and where our edge is:

- **Mailchimp** — drag-drop builder (text/image/button/divider/spacer/social/video blocks), templates, reporting on opens/clicks/e-commerce revenue. Prices per **contact** (~£100/mo at 8k contacts, unsubscribed contacts count) — exactly the cost profile we undercut.
- **Klaviyo** — strongest segmentation + revenue attribution (e-commerce), but **no native countdown timer** (users pay third parties like MailTimers/CountdownMail ~$10+/mo). Per-profile pricing ($150/mo at 10k).
- **Brevo** — prices per email volume (~£8/mo for 5k), blocks-based builder; our allowance+PAYG pricing is benchmarked against it.
- **MailerLite** — the block benchmark: text, image, button, divider, **countdown**, product cards, video, saved reusable modules.
- **SevenRooms** — the hospitality comparator: email campaigns on the same data layer as reservations, so bookings/covers/revenue are attributed automatically (case study: $1.3M + 18k covers attributed across 3 venues in 18 months). Enterprise-priced. **This is the model** — we have the same data layer and can ship the same attribution story at ~10× less.
- **Industry context** — restaurant/café email benchmarks: ~40% open, ~1% click. **Apple Mail Privacy Protection auto-fires opens** for Apple Mail users, so opens are inflated and directionally-only; clicks and conversions are the trustworthy metrics. Our reporting leads with clicks + bookings and labels opens accordingly.

Positioning: "the email tool that knows if the campaign filled tables" — attribution is the differentiator, the builder is table stakes.

---

## Part 1 — Email builder

### Document model

Campaign emails become a structured **block document** (versioned JSON) instead of a text body:

```
campaigns.body_doc jsonb null   -- { v: 1, blocks: Block[] }; null = legacy plain-text body
```

`Block` is a discriminated union (`lib/campaigns/blocks.ts`, zod-validated — operator-supplied JSON is untrusted input):

| Block | Fields | Phase |
|---|---|---|
| `heading` | text (merge tags OK), level 1–2 | A |
| `text` | limited rich text: bold/italic/links + merge tags | A |
| `image` | storage path, alt (required), optional link, width % | A |
| `button` | label, url, style (filled/outline) — brand colours from venue branding | A |
| `divider` | style | A |
| `spacer` | height (S/M/L) | A |
| `bookingCta` | button that deep-links to `/book/[slug]` with optional party/date prefill; **carries attribution param automatically** | B |
| `countdown` | target datetime (e.g. event start), caption | C |
| `eventCard` | image + title + datetime + bookingCta composite | C |
| `social` | venue's social links from settings | C |
| `columns` | 2-col wrapper (stacks on mobile) | C |

### Rendering

- `lib/campaigns/render.tsx` gains a doc renderer: **600px table layout, inline styles, email-safe HTML** (no flexbox/grid — Outlook), venue branding (existing `parseBranding`), bulletproof buttons (VML fallback), stacked single column on mobile.
- The **unsubscribe footer stays non-removable** — appended by the renderer, never a block (same guarantee as today).
- A **plain-text part** is generated from the doc (deliverability + accessibility).
- Merge tags keep working inside text/heading/button labels via the existing marketing tag pipeline.
- Legacy campaigns (`body_doc` null) render exactly as today — no migration of old rows.

### Images

- Upload to **Supabase Storage, UK region** (residency rule 6 — no new sub-processor), reusing the `venue_photos` pipeline pattern: type allowlist (jpeg/png/webp), 2 MB cap, server-side re-encode + strip EXIF, served by public CDN URL.
- New bucket `campaign_assets`, org-scoped path prefix + RLS storage policy; assets are venue marketing content, not guest PII.

### Countdown block (Phase C)

Self-hosted — no third-party countdown service (the gap Klaviyo users pay $10+/mo to fill):

- `app/api/countdown/[token].gif` — signed token encodes campaign + target time; renders a ~60-frame animated GIF of the remaining time at request time, `Cache-Control: private, max-age=60`.
- Known caveats, documented in the operator UI: Apple MPP prefetches through Apple's proxy (the guest may see a time snapshot from prefetch), and the GIF freezes on last frame in some clients. After the target passes, render "It's on!" fallback frame.
- No guest identifier in the token — the countdown is per-campaign, not per-recipient (no tracking surface, GDPR-clean).

### Editor UI

- `campaign-composer.tsx` grows a **builder mode** for the email tab (SMS/WhatsApp keep the plain composer): block palette → canvas (tap to add, drag to reorder, duplicate/delete) → inspector panel for the selected block.
- Live preview via the existing `previewCampaign` server action (now doc-aware) in the existing sandboxed iframe; **test-send to self** button (renders + sends to the operator's email, marked `[TEST]`, not counted in usage/allowance).
- **Saved templates** (Phase C): `campaign_templates` table (org-scoped, RLS + isolation test) — save a doc as a starting point; ship 3–4 seeded starters (event announcement, new menu, quiet-night offer, newsletter).
- Autosave drafts of `body_doc` on the campaign row.

## Part 2 — Reporting & booking attribution

### Attribution model (the differentiator)

Two mechanisms, strongest-wins, stored on the booking:

```
bookings.campaign_id        uuid null references campaigns(id) on delete set null
bookings.attribution_kind   text null check (attribution_kind in ('link','click_window'))
-- + index on (campaign_id) where campaign_id is not null
```

1. **Link attribution (deterministic).** Every URL in a rendered campaign email pointing at our booking surfaces (`book.tablekit.uk/*`, `/book/[slug]`) gets `?tk_c=<campaignId>` appended at render time (including `bookingCta` blocks). The widget/booking page carries it through the wizard (first-party, cookieless — piggyback the existing session flow) and stamps `campaign_id` + `attribution_kind='link'` on the created booking.
2. **Click-window fallback (probabilistic).** Nightly job: bookings without link attribution whose guest has a `campaign_sends.clicked_at` within **7 days** before booking creation → stamp `attribution_kind='click_window'`. Uses only data we already hold; reported separately, never blended silently.

DSAR erasure already scrubs `campaign_sends`; booking attribution columns carry no PII beyond the existing guest linkage and follow the booking's lifecycle.

### Per-campaign report page

`/dashboard/venues/[venueId]/campaigns/[campaignId]` (manager; basic stats Core+, funnel/attribution sections Plus):

- **Funnel:** queued → sent → delivered → opened† → clicked → **bookings → covers → deposits taken** (realised revenue proxy until POS spend lands via `pos-integrations.md`).
- † opens labelled "inflated by Apple Mail privacy — treat as directional"; clicks and bookings are the headline metrics.
- Rates: delivery, open, CTR, click-to-open, **booking conversion (bookings / delivered)**; unsubscribes attributed to the campaign (unsubscribe link already carries send context — count per campaign).
- Send timeline + failures table (bounce/error reasons from `campaign_sends.error`).
- Link-level clicks (Phase C): `campaign_link_clicks (campaign_id, url, count)` fed by the Resend `email.clicked` webhook payload's URL — extend the existing handler, one new small table (RLS).

### Marketing overview page

`/dashboard/venues/[venueId]/campaigns/reports` — trailing-90-day roll-up: sends/opens/clicks/bookings by channel, top campaigns by booking conversion, audience health (consented list growth, unsubscribe rate per channel). CSV export (existing exporter pattern from `reporting.md`).

### Data + webhook changes

- Extend the Resend webhook handler: it already stamps `opened_at`/`clicked_at` — add per-URL click recording (Phase C) and unsubscribe attribution counts.
- `campaigns.counts` jsonb gains `bookings`, `covers` (denormalised by the attribution stamp + nightly job for the dashboard list).

## Phasing

- **Phase A — builder core:** block schema + renderer + editor (heading/text/image/button/divider/spacer), image uploads, doc-aware preview + test-send. *Ships user-visible value alone.*
- **Phase B — attribution + reports:** `tk_c` param end-to-end, booking columns + widget stamp, click-window job, per-campaign report page with the booking funnel.
- **Phase C — rich blocks + polish:** bookingCta prefill, countdown endpoint + block, eventCard/social/columns, saved templates + starters, link-level clicks, overview page.

Each phase ends per the house rules: tests (unit for block validation/rendering/costing, RLS isolation for `campaign_templates` + `campaign_link_clicks`, e2e smoke for build→send→report), a forward-only migration plan, and a security check (`@code-reviewer` + `@gdpr-auditor` — Phases A/B touch guest data paths).

## Acceptance criteria

- [ ] Block doc is zod-validated server-side; unknown/oversized/malformed docs are rejected (no stored-XSS via block fields; all text HTML-escaped at render).
- [ ] Rendered emails: 600px table layout, plain-text part, branding applied, unsubscribe footer non-removable, renders acceptably in Outlook/Gmail/Apple Mail (Litmus-style manual pass pre-launch).
- [ ] Legacy plain-text campaigns unaffected; SMS/WhatsApp composer unchanged.
- [ ] Images only via the org's own bucket path; type/size enforced server-side; EXIF stripped; UK region.
- [ ] Booking made through a campaign link is attributed deterministically; click-window attributions are visibly separated; a booking never gets two campaign attributions.
- [ ] Report page shows the full funnel including bookings/covers/deposits; opens carry the MPP caveat.
- [ ] Countdown endpoint leaks no guest identifiers; token is signed and campaign-scoped.
- [ ] New tables ship RLS + cross-tenant isolation tests (rule 3).
- [ ] Test-sends don't count toward usage, allowance, or engagement stats.
- [ ] Tier gating: Core sees builder + basic stats; attribution reports and the overview dashboard require Plus (server-enforced, not just hidden). Attribution capture runs for all tiers.

## Out of scope

- A/B testing, send-time optimisation, automations/journeys (Phase-4 segment engine owns automations).
- Custom HTML import, third-party ESP integrations, deliverability tooling (dedicated IPs, DMARC dashboards).
- Countdown/attribution for SMS/WhatsApp (email-first; SMS link-shortening + attribution is its own spec later).
- POS-revenue attribution (lands with `pos-integrations.md`; deposits are the v1 revenue proxy).
