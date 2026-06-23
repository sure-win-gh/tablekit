# Playbook: Cloudflare edge protection

**Audience:** the operator (solo), with Claude Code as an assistant.
**Read before:** changing WAF/rate-limit rules, or during an active abuse incident.
**Scope:** edge configuration that lives in the Cloudflare dashboard (or Terraform),
not application code. The app-level companion lives in `lib/public/rate-limit.ts`
and the auth/booking route handlers.

## Why this layer exists

Cloudflare sits in front of Vercel (orange-cloud proxy — see `deploy.md`). A request
blocked here never reaches Vercel, so it costs us **no function invocation, no
database query, and no Upstash round-trip**. That is the whole point: the edge
absorbs volumetric abuse; the app enforces correctness.

Two layers, two jobs:

| Layer | Where | Protects against | Cost of a blocked request |
|-------|-------|------------------|---------------------------|
| **Cloudflare (edge)** | Dashboard / Terraform | Floods, credential stuffing, scraping, bot signups | Free — dropped before Vercel |
| **App (`lib/public/rate-limit.ts`)** | Route handlers | Correctness boundary, per-account limits, idempotency | A function spin-up + Redis call |

The app limiter **fails open** if Upstash is unconfigured (by design, for dev/CI).
That makes Cloudflare the only always-on network defence. Treat it as load-bearing.

> Note: our specs already assume this layer exists — see `docs/specs/auth.md`
> ("Auth endpoints rate-limited at Cloudflare") and `docs/specs/bookings.md`
> ("Cloudflare adds the anonymous network layer"). This runbook is where that
> assumption gets made real.

## Decision: Cloudflare is the edge — Vercel's WAF/Bot Protection stays OFF

We run **one** security edge, and it's Cloudflare. **Do not also enable Vercel's
WAF, Bot Protection, or Attack Challenge Mode** and expect them to help — they will
not, and the combination is worse than either alone.

Why they conflict (this is structural, not a tuning problem):

- Both products want to be the *outermost* layer that sees the real client. Only
  one can be. With our orange-cloud proxy, every request reaches Vercel from a
  **Cloudflare edge IP**, not the visitor's.
- **Vercel Bot Protection** scores on direct client signals (IP, TLS fingerprint,
  behaviour) that the proxy masks — so accuracy collapses. Vercel's own docs state
  it "doesn't work when a reverse proxy is placed in front." Worse, Cloudflare
  rotates exit IPs, so Vercel can re-challenge legitimate users on every IP change.
- **Vercel WAF IP rules / threat intelligence** key off the connecting IP — now
  Cloudflare's, not the attacker's — so reputation data is about Cloudflare.

This is a deliberate choice, not a loss: the repo is already built around Cloudflare
(DNS, TLS termination, `cf-connecting-ip` reads in `lib/public/rate-limit.ts`, the
sub-processor list in `gdpr.md`). Vercel's WAF was never our primary line.

**The trap to avoid:** turning on Vercel Bot Protection later thinking it's free
defence-in-depth. It isn't — behind Cloudflare it's flying blind. If we ever want
to switch to Vercel-only, that's the opposite move: drop the orange-cloud proxy
(DNS-only) so Vercel sees real clients again, and retire this runbook. Don't run
half of each.

## IP banning: use it deliberately

IP banning is the bluntest tool here. It works, but:

- **Attackers rotate IPs cheaply** — botnets, residential proxies, CGNAT. A
  permanent ban on one address rarely stops a determined attacker.
- **Legitimate users share IPs** — corporate NAT, mobile carriers (CGNAT), a whole
  café on one connection. A permanent IP ban can take out real customers.

**Rule of thumb:** prefer automatic, *temporary* mitigation (rate-limit rules,
challenges) over manual, *permanent* IP bans. Reserve hard IP bans for incident
response against a known-bad address that is actively attacking, and review them
on a schedule so they don't rot into silent customer lockouts.

Preference order, most to least:

1. **Rate Limiting Rules** — automatic, temporary, scoped to a path. First choice.
2. **Managed Challenge / Turnstile** — separates humans from bots without banning
   anyone. Best for auth + booking forms.
3. **Manual IP Access Rules** — incident-response only; temporary by default.

## DNS, TLS & SSL (the foundation — set these once)

Before any protection rules, get the zone's transport posture right. These mirror
the guarantees the rest of the stack assumes (`security.md` §Transport, `gdpr.md`
§Encryption, `deploy.md`). All on the **Free** plan.

| Setting | Where | Value | Why |
|---------|-------|-------|-----|
| Proxy status | DNS → records | **Proxied (orange cloud)** for `tablekit.uk`, `app.`, `book.`, `api.` | This is what puts Cloudflare in the path; DNS-only (grey) records bypass every rule below. Mail/SPF/DKIM/DMARC records stay DNS-only. |
| SSL/TLS mode | SSL/TLS → Overview | **Full (strict)** | Validates the Vercel origin cert end-to-end. "Flexible"/"Full" (non-strict) would allow an unverified origin leg — never use them. |
| Always Use HTTPS | SSL/TLS → Edge Certificates | **On** | Redirects http→https at the edge. |
| Minimum TLS Version | SSL/TLS → Edge Certificates | **1.3** | Matches `security.md` "TLS 1.3 minimum". |
| HSTS | SSL/TLS → Edge Certificates | **On**, `max-age ≥ 12 months`, includeSubDomains, **preload** | Matches "HSTS preload on dashboard + widget origins". ⚠️ Preload is hard to undo (browsers cache it for the max-age) — enable deliberately, only once HTTPS is solid on every subdomain. |
| Automatic HTTPS Rewrites | SSL/TLS → Edge Certificates | **On** | Upgrades mixed-content sub-resource URLs. |
| DNSSEC | DNS → Settings | **On** | Matches `deploy.md`; signs DNS responses against spoofing. Enable at the registrar too. |

Certificates renew automatically (Cloudflare edge cert + the Vercel origin cert);
no manual rotation. There is nothing app-side to configure for any of the above.

## Caching (keep dynamic surfaces uncached)

Cloudflare's default cache only stores static assets, but be explicit so a future
config change can't accidentally cache authenticated HTML:

- **Never cache** `app.` (dashboard/admin), `api.`, and all `/api/*` paths — they're
  per-user/per-org and per-request (the dashboard CSP is nonce'd, so caching the HTML
  would serve a stale nonce). Add a Cache Rule: **Bypass cache** for `app.tablekit.uk`
  and any `/api/*`.
- **Cacheable:** static assets (`/_next/static/*`, fonts, images) — long-TTL,
  immutable. The public widget/booking HTML is SSR and may be edge-cached by path;
  leave Vercel's `Cache-Control` to drive it rather than overriding at Cloudflare.

## Baseline configuration (set these up)

All of the following are available on Cloudflare's **Free** plan unless noted.

### 1. Rate Limiting Rules (highest value — do this first)

Cloudflare dashboard → **Security → WAF → Rate limiting rules**. Match on the
`cf-connecting-ip` (the same header `ipFromHeaders()` reads, so app + edge agree
on identity). Suggested starting rules — tune against real traffic:

| # | Path / matcher | Threshold | Period | Action | Mitigation timeout |
|---|----------------|-----------|--------|--------|--------------------|
| R1 | `/login` (POST) | 10 req | 1 min | Managed Challenge | 10 min |
| R2 | `/signup` (POST) | 10 req | 1 min | Managed Challenge | 10 min |
| R3 | `/api/v1/bookings` (POST) | 30 req | 1 min | Block | 10 min |
| R4 | `/api/v1/availability` (GET) | 120 req | 1 min | Block | 10 min |
| R5 | `/api/v1/*` (any) — catch-all | 600 req | 1 min | Block | 5 min |

Notes:
- These edge thresholds sit **above** the app-level limits (auth 5/IP/15min in
  `login/actions.ts`; bookings 5/10min per IP, availability 30/min in the route
  handlers). The edge catches floods; the app catches the precise abuse. They are
  intentionally not identical — the edge is the coarse net.
- Use **Managed Challenge** (not Block) on `/login` and `/signup` so a real human
  who fat-fingered their password a few times gets a checkbox, not a wall.
- Free plan allows one rate-limiting rule with limited config; the full table
  above assumes the paid **Rate Limiting** add-on (cheap, and worth it once you
  have paying venues). Start with R1 on Free, expand on upgrade.

### 2. Managed Challenge / Turnstile on forms

Our `security.md` calls for a CAPTCHA after repeated auth attempts. Turnstile is
Cloudflare's free, privacy-friendly equivalent and keeps us on one vendor (it is
already a sub-processor per `gdpr.md`, so no new DPA).

- Enable a **Managed Challenge** on the auth surfaces via the rate-limit rules above.
- For the public booking widget, Turnstile can be added to the form; it is
  cookieless and GDPR-friendly. Coordinate with the existing hCaptcha plan in
  `security.md` — pick one, don't run both.

### 3. Bot Fight Mode

Dashboard → **Security → Bots**. Turn on **Bot Fight Mode** (Free). It challenges
obvious automated traffic across the whole zone. Low effort, broad coverage.
On a paid plan, prefer **Super Bot Fight Mode** for finer control (allow verified
bots like Googlebot — important, we use Reserve with Google).

### 4. Managed WAF rulesets (paid plans)

If/when on a paid plan, enable the **Cloudflare Managed Ruleset** and the **OWASP
Core Ruleset** (start in *log* mode, then *block* after watching for false
positives). These give generic SQLi/XSS protection layered behind our already-solid
app-level input validation (Zod + Drizzle parameterised queries). Defence in depth,
not a substitute.

### 5. Allow our own infrastructure

Add **Skip** rules (WAF → Custom rules → *Skip* all remaining rules + Rate
limiting) for the signed server-to-server endpoints below — they're
signature-verified in-app, so a WAF challenge or rate-limit would only break
legitimate, already-authenticated traffic. The actual receiver paths in this repo:

| Path | Source | Verification |
|------|--------|--------------|
| `/api/stripe/webhook` | Stripe (platform + Connect) | `Stripe-Signature` |
| `/api/twilio/webhook` | Twilio (SMS/WhatsApp status) | `X-Twilio-Signature` |
| `/api/resend/webhook` | Resend (delivery events) | Svix signature |
| `/api/webhooks/resend-inbound` | Resend (inbound email) | Svix signature |
| `/api/webhooks/pos` | Square / Lightspeed / generic POS | provider HMAC |
| `/api/pos/ingest` | Generic POS push | shared-secret HMAC |

Also never challenge/rate-limit:
- **`/monitoring`** — the Sentry browser-event tunnel (`tunnelRoute` in
  `next.config.ts`). High-frequency same-origin POSTs that a bot rule would
  otherwise eat, blinding error tracking.
- **`/api/health`** — the uptime-monitor readiness probe (polled on an interval;
  also excluded from `proxy.ts`).
- **Reserve with Google** retries from many IPs — never rate-limit RWG `/api/...`
  paths by IP. See `security.md` ("Google retries from many IPs").

(Vercel's own egress / health checks originate from Vercel, behind Cloudflare, so
they aren't subject to these inbound rules.)

## Incident response: banning an IP under active attack

When a specific address (or small range) is actively abusing us and the
rate-limit rules aren't enough:

1. **Identify.** Pull the offending `cf-connecting-ip` from Sentry context, Vercel
   logs, or Cloudflare → **Security → Events**. Confirm it's a single source and
   not shared infrastructure (a `/32` is safer to ban than a `/16`).
2. **Ban temporarily.** Dashboard → **Security → WAF → Tools → IP Access Rules**.
   Add the IP/CIDR with action **Block**, scoped to this zone.
   - Default to a **time-boxed** ban. Note the expiry in `#incidents` and set a
     reminder to review.
   - Prefer **Managed Challenge** over **Block** if there's any chance the IP is
     shared — it stops scripts while letting humans through.
3. **Log it.** Record the IP, reason, action, and review date in the incident
   thread (`#incidents`) and, for anything material, the post-mortem file in
   `incidents/`.
4. **Escalate the pattern, not the IP.** If the attacker rotates IPs, stop playing
   whack-a-mole — switch to a **Rate Limiting Rule** or a **Managed Challenge** on
   the targeted path, or enable **Under Attack Mode** for the zone (see below).
5. **Review and lift.** Stale IP bans become silent customer lockouts. Review the
   IP Access Rules list monthly; remove anything past its review date.

### Under Attack Mode (zone-wide nuclear option)

Dashboard → **Overview → Under Attack Mode**, or the security level toggle. Presents
an interstitial challenge to *all* visitors for a few seconds. Use only during a
sustained flood that's degrading the service — it adds friction for every real user,
so flip it back off once the attack subsides. Treat it like a P0/P1 kill switch
(see `incident.md`).

## What stays in code vs. Cloudflare

- **Cloudflare (this runbook):** volumetric rate limiting, IP bans, bot challenges,
  managed WAF rulesets. Configured in the dashboard or Terraform. Not in the app repo.
- **App (`lib/public/rate-limit.ts` + route handlers):** per-account limits, the
  precise per-IP/per-email booking and auth limits, idempotency, and the correctness
  boundary. These are tested (`tests/unit`) and version-controlled.

If we ever want an operator-controllable blocklist (ban an IP or email from the
dashboard without touching Cloudflare), that's an app-side feature checked in
`proxy.ts` — out of scope here, tracked separately.

## Quick reference

| I want to… | Go to |
|------------|-------|
| Set TLS/DNS baseline (once) | SSL/TLS → Overview (**Full strict**) + Edge Certificates (TLS 1.3, HSTS, Always HTTPS) |
| Throttle a path automatically | Security → WAF → Rate limiting rules |
| Ban one bad IP right now | Security → WAF → Tools → IP Access Rules (time-boxed) |
| Challenge bots zone-wide | Security → Bots → Bot Fight Mode |
| Survive a sustained flood | Overview → Under Attack Mode (temporary) |
| Stop webhooks/tunnel being challenged | WAF → Custom rules → Skip for the §"Allow our own infrastructure" paths |
| See who's hitting us | Security → Events |

## Review cadence

- **Monthly:** review IP Access Rules; remove expired/stale bans.
- **Quarterly:** re-tune rate-limit thresholds against real traffic; confirm
  webhook source ranges still skip the WAF.
- **After any incident:** capture rule changes in the post-mortem so the config has
  an audit trail even though it lives outside the repo.
