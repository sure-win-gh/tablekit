# Playbook: Security baseline

**Audience:** Claude Code and the operator.
**Read before:** adding new endpoints, auth flows, or data access paths.

## Threat model (quick)

Primary threats we design against:
1. **Cross-tenant data leakage** — a bug that lets org A see org B's bookings or guests.
2. **Credential stuffing and account takeover** — especially of operator accounts (owner role can see all guest data).
3. **Booking form abuse** — bots making fake bookings, sending spam via confirmation emails.
4. **Webhook forgery** — fake Stripe/Twilio/Resend callbacks.
5. **PII exfiltration** — via a vulnerable endpoint, SQL injection, or SSRF.
6. **Widget XSS** — untrusted venue content embedded on third-party sites.

Not the primary target (yet): nation-state actors, supply-chain compromise of all dependencies, physical access.

## Baseline controls (non-negotiable)

### Authentication
- Supabase Auth with email + password and magic link. TOTP MFA available from day one; mandatory for `owner` role by GA.
- Passwords: min 12 chars, HIBP check on signup, bcrypt via Supabase.
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, rotated on privilege change.
- No "remember me" past 14 days without re-auth.

### Authorisation
- **Row Level Security on every table** that contains organisation data. No exceptions.
- Enforce organisation scoping at the RLS layer, not only in application code.
- Every PR that adds a table must include the RLS policy in the same migration.
- Run `scripts/check-rls.ts` in CI — fails if any table has `rls disabled`.

### Input validation
- All server actions and API routes use Zod schemas at the boundary. No raw `req.body` deserialisation.
- Drizzle parameterised queries only. No string concatenation into SQL.
- File uploads: validate MIME, size cap 5MB, scan with ClamAV via Supabase (for CSV imports).

### Secrets
- All secrets in Vercel env vars or Supabase Vault. Never in git, never in `.env.local.example`.
- Rotate all secrets if a contributor leaves (solo operator: if device is lost/sold).
- Use different keys per environment (dev, staging, prod).

### Transport
- HTTPS-only, HSTS preload, TLS 1.3 minimum.
- Certificate auto-renewed via Vercel / Cloudflare.

### Content Security Policy
- Dashboard (`app.tablekit.uk`): strict CSP, no inline scripts except nonced, `frame-ancestors 'none'`.
- Widget host (`book.tablekit.uk`): allow framing by `*` (embeddable), but strict script-src.
- No `unsafe-inline` in production.

**Current state:**

- **Authenticated app (`/dashboard`, `/admin`): nonce-based CSP.** Generated per request in
  `proxy.ts` (`lib/security/csp.ts` builds it); `script-src 'self' 'nonce-…' 'strict-dynamic'`
  with **no `'unsafe-inline'`** — Next.js stamps the nonce onto its framework scripts; these
  surfaces load no inline or third-party client scripts (Stripe on the dashboard is a full-page
  redirect, hCaptcha is widget-only, Sentry is a self-hosted chunk). `style-src` keeps
  `'unsafe-inline'` **by design** — React renders inline `style={{}}` attributes that can't be
  nonced, and style injection is low XSS risk. So "no `unsafe-inline`" above means **scripts
  only**. Ships **Report-Only** first; `CSP_DASHBOARD_ENFORCE=true` flips it to enforcing (an env
  change after a soak — no code change, instantly reversible). Violations → `/api/csp-report`.
- **Public widget surfaces (`/embed`, `/book`): still Report-Only** (`next.config.ts`), with
  `unsafe-inline` retained. **Enforcing is deferred** — they embed third-party scripts
  (Stripe Elements, hCaptcha) and are edge-cached + run on customer sites, so a nonce migration
  carries real breakage risk for a defense-in-depth layer. Tracked as a separate future project.

### CORS — same-origin by design (no `Access-Control-Allow-Origin`)
We emit **no** CORS headers, and that is the correct, secure default for this architecture, not
an omission:
- The embeddable widget runs in a same-origin iframe served from our own host.
- The Plus-tier REST API (`/api/v1`) is authenticated by bearer token (backend-to-backend), so
  no browser ever makes a cross-origin call that would need CORS.
A future change must **never** add a wildcard `Access-Control-Allow-Origin: *`. A guard test
(`tests/unit/no-cors-wildcard.test.ts`) asserts no `Access-Control-Allow-Origin` appears in
`next.config.ts` headers or any `app/api/**` route.

### Auth invariants (production)
- **Email confirmation must stay ON.** Signup relies on Supabase's "Confirm email" project
  setting: with it on, `signUp()` returns no session and the action returns `needs_confirm`. If
  it were turned off, signups would be granted a session immediately (unverified address). This
  setting lives in the Supabase dashboard, not in code — keep it on in production (see the
  deploy checklist). As a tripwire, the signup action reports to Sentry if it ever sees a live
  session straight after signup in production.

### Rate limiting
- Auth endpoints: 5 attempts per IP per 15 minutes, 3 per account per hour.
- Booking widget: 20 requests per IP per minute, CAPTCHA (hCaptcha) after 5.
- API: 100 req/min per org for reads, 20/min for writes.
- Implemented at Vercel Edge with Upstash Redis for state.
- **Network-layer limits, bot challenges, and IP bans live at Cloudflare — see
  `cloudflare.md`.** The edge absorbs floods before they reach Vercel; the app
  limiter (which fails open if Upstash is unconfigured) enforces the precise
  per-account boundary.

### Headers
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` on dashboard (SAMEORIGIN would still allow clickjacking the same brand)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### Dependencies
- `pnpm audit` in CI, blocking on high/critical.
- Dependabot enabled, auto-PR for patches.
- Pin all versions. No `^` or `~` in `package.json`.
- Review every new direct dependency (package.json line added) — does it really need to be in the bundle? Can it be a one-file inlined helper?

### Logging and monitoring
- Sentry captures exceptions with PII scrubbing (see `gdpr.md`).
- Audit log captures: auth events, role changes, exports, deletions, refunds, DSAR actions.
- Anomaly alerts: spike in 5xx, spike in auth failures, webhook signature failures, Stripe Radar alerts.

## Cross-tenant bugs: how to prevent

This is the single most likely serious bug in a multi-tenant app. Prevention checklist whenever a query touches org-scoped data:

1. Is RLS enabled on the table? (`select relname, relrowsecurity from pg_class where ...`)
2. Is there a policy that scopes by `organisation_id`?
3. Is the Drizzle query using the `authed` client (RLS applied) and not the `service_role` client?
4. Does the test suite include a cross-tenant test: org A cannot read org B's row?

The `code-reviewer` subagent is configured to flag any use of the `service_role` Supabase client outside `lib/server/admin/`.

## Webhook verification

Every inbound webhook verifies a signature:
- Stripe: `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`.
- Twilio: `X-Twilio-Signature` with account auth token.
- Resend: `Svix-Signature` with webhook secret.
- Reserve with Google: HMAC-SHA256 of request body with shared secret.

Endpoints that fail verification return 400 and are logged (but not counted toward per-IP limits — Google retries from many IPs).

## Widget XSS

The booking widget is embedded on venue websites we don't control. Rules:
- Widget script is served from `book.tablekit.uk` only (not a CDN mirror) so we can update it.
- No `postMessage` wildcards — validate origin against the venue's allowed domains (stored in `venues.allowed_origins`).
- Widget never reflects user input as HTML. React's default JSX escaping is sufficient; no `dangerouslySetInnerHTML`.
- SRI hash in the embed snippet.

## Secret rotation schedule

| Secret                       | Rotation cadence |
|------------------------------|------------------|
| Supabase service_role        | Quarterly, or on suspected exposure |
| Stripe webhook secret        | Quarterly |
| Encryption master key (Vault)| Annually (re-wrap keys, no data re-encrypt needed) |
| Twilio auth token            | Quarterly |
| Resend API key               | Quarterly |
| Session signing secret       | Quarterly |

Calendar reminders in the operator's calendar.

## Vulnerability disclosure

- `/.well-known/security.txt` published with contact.
- Public security policy at `/security` with scope, safe harbour, response SLA (7 days triage, 30 days fix for critical).
- No bug bounty on MVP (no budget). Gratitude and a t-shirt when we can afford it.
