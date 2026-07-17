# Spec: Custom HTML emails + Canva integration (SCOPING)

**Status:** Phase 2 built (2026-07-10, pending PR; migration 0060 applied): "Paste HTML" composer mode (+ .html upload), `sanitize-html` dependency (pinned — run `pnpm install` to register locally), `lib/campaigns/html-import.ts` sanitiser (allowlist tags/attrs/styles, http(s)-only URLs, 300 KB reject / 100 KB Gmail-clip warning, `<style>`/MSO-comment removal surfaced as warnings), save-time + send-time passes, forced compliance footer shell, tk_c rewriting, HTML-escaped merge tags, plain-text projection, live-preview warnings. 15 hostile-fixture tests in `campaign-html-import.test.ts`. **Responsive CSS is preserved** (revised from the original strip-`<style>` scope after review): `<style>` contents are parsed with postcss and kept under three constraints — only plain rules + `@media` survive (`@import`/`@font-face` dropped), every declaration passes the same property/value allowlist as inline styles, and every selector is scoped under `.tk-content` (the wrapper around the operator's HTML) so pasted CSS can never touch the compliance footer (`body { display:none }` becomes `.tk-content { … }`). `class`/`id` attributes are kept on markup so the rules match; the sanitised sheet travels with the stored HTML and is re-sanitised at send (idempotent scoping); 50 KB CSS cap. Client caveat (documented in UI copy): media queries work in Gmail/Apple Mail/Outlook.com but not Outlook desktop — same as the source tool's own sends. Phases 1 (image-first, shipped) and 3 (Canva Connect) unchanged below; image re-hosting (SSRF-guarded fetch) still deferred.
**Depends on:** `marketing-suite.md` (builder, renderer, attribution, templates), `email-broadcast-billing.md` (send costs unchanged), `docs/playbooks/gdpr.md` (sub-processors), `docs/playbooks/security.md`

## The ask

Let operators fully customise campaign emails: paste or upload complete HTML (specifically from Canva), and ideally integrate with Canva directly.

## Research findings (July 2026)

1. **Canva now has a dedicated Email design type ("Canva Email") with real HTML export** — Share → Download → HTML, or a ZIP of HTML + image assets after a test send. So "copy the HTML from Canva" is genuinely possible, with caveats: only email-safe fonts survive; any non-native element (embedded designs, effects) is flattened to an image; and exported image references may need re-hosting at proper URLs.
2. **Canva Connect API** exists for a first-class integration: OAuth per user, async design-export jobs (750 exports/5 min per integration, download URLs valid 24h), assets upload, design listing. Export **formats depend on design type** — PNG/JPG/PDF are universal; HTML export via the API for Email designs needs verifying against the `export-formats` endpoint before we commit to it.
3. Peer platforms (Klaviyo, Omnisend) support "import custom HTML template" as a distinct editor mode next to their block builders — the pattern we'd follow.

## Recommendation — three phases

### Phase 1 — image-first Canva workflow (SHIPPED, today)

Operators already have a good Canva path with zero new machinery: design in Canva → export PNG/JPEG → upload as the email **banner** or as **image blocks** (with the booking CTA button and countdown from our builder on top, which keeps attribution + the live countdown working). This should be the *documented, recommended* Canva workflow in help copy regardless of later phases — it sidesteps every HTML-import risk below.

### Phase 2 — "Custom HTML" mode (the core build, ~2–3 days)

A third content mode in the email composer: `Blocks | Plain text | Custom HTML` — paste the HTML from Canva Email's export (or any other tool: BeeFree, an agency, Mailchimp exports).

- **Storage:** `campaigns.html_body text` (null = not a custom-HTML campaign). Stored ONLY post-sanitise; re-sanitised at send time (defence in depth, same posture as `body_doc`).
- **Sanitisation (the crux):** server-side allowlist sanitiser — this needs a real HTML parser, so it's the first place we'd add a dependency (`sanitize-html` — mature, allowlist-based). Policy: allow table-layout + text tags + `img`/`a`; `href`/`src` http(s)-only; inline `style` filtered through a CSS-property allowlist (no `expression`, no `url()` except https images, no `position:fixed`); strip `script`/`iframe`/`form`/`svg`/`object`/`meta`/`link`, all `on*` handlers, and comments (including MSO conditionals in v1 — a scope decision that slightly degrades Outlook fidelity but closes a fiddly attack surface).
- **Compliance is non-negotiable:** pasted HTML is wrapped by our shell, which appends the unsubscribe footer + "Sent by X via TableKit" exactly like builder emails — the operator cannot ship an email without it. `List-Unsubscribe` headers already come from `sendEmail`.
- **Attribution keeps working:** during sanitise, rewrite booking-surface `href`s with `?tk_c=` via the existing `appendCampaignParam` (a `transformTags` hook) — so the Phase-B funnel works for custom HTML too.
- **Merge tags:** interpolate `{{guestFirstName}}`/`{{venueName}}` in text nodes, with values HTML-escaped on injection.
- **Size guardrails:** hard reject > 300 KB post-sanitise; warn > 100 KB (Gmail clips at ~102 KB — Canva exports run heavy).
- **Images:** v1 leaves image URLs pointing at their original host with a deliverability warning; v2 adds "import images" (server fetches + re-uploads to `campaign-assets`) — deferred because server-side fetching of operator-supplied URLs is an SSRF surface needing private-IP blocking + size caps.
- **Plain-text part** extracted from the sanitised HTML.
- Preview/test-send flow through the same pipeline; the live-preview iframe is already sandboxed.

**Honest risk note:** custom HTML trades away things the block builder guarantees — responsive rendering, the countdown/booking blocks, per-client testing. The report page and billing are unaffected.

### Phase 3 — Canva Connect integration (~3–5 days, after P2)

"Import from Canva" inside the builder: per-org OAuth, list designs, run an export job, pull the result in.

- **3a (do first):** export as **PNG** → drops straight into a banner/image block. Works for every Canva design type, no HTML risk, and honestly delivers most of the perceived value ("my Canva design in my email in two clicks").
- **3b (verify first):** export **HTML** for Canva Email designs via the API → feed through the Phase-2 sanitiser. Gate on confirming HTML appears in the API's export formats for email designs.
- **Plumbing:** Canva developer-app registration (their review process — lead time), encrypted token storage (`canva_connections`, org-scoped RLS + isolation test), export-job polling. Rate limits are a non-issue at our scale. Canva is a US sub-processor touch-point — no guest PII flows (designs + operator OAuth only), but add a note to `gdpr.md` for transparency.

## Sequencing recommendation

Document Phase 1 now (help copy) → build Phase 2 (unlocks paste-from-anywhere, not just Canva) → 3a as a fast follow → 3b once the API's HTML export is confirmed. Phase 2 is the one to schedule deliberately: the sanitiser is security-sensitive and should get the `@code-reviewer` + property-style tests (hostile fixtures: script smuggling, css url() exfil, unsubscribe-stripping attempts) treatment.

## Out of scope

- Editing imported HTML inside our builder (import is replace-only; edits happen in the source tool).
- Automatic conversion of arbitrary Canva designs (non-Email types) to HTML.
- MSO conditional-comment preservation (v1).
