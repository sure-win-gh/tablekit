# Playbook: Incident response

**Audience:** the operator (solo), with Claude Code as an assistant during triage.
**Trigger:** anything that materially affects availability, integrity, or confidentiality.

## Severity levels

- **P0 — critical.** Data breach, mass outage, payment processing broken for all venues, RLS bypass. Respond immediately.
- **P1 — major.** One venue down, webhook backlog, messaging provider outage, widget loading slowly. Respond within 1 hour.
- **P2 — minor.** Single-user bug, cosmetic issue, non-urgent data correction. Respond within 1 business day.

## Detection sources

- Sentry alerts (5xx spike, new error type, unhandled rejection).
- Uptime monitor (Better Stack or similar) for `/api/health`, `book.tablekit.uk`, `app.tablekit.uk`.
- Stripe Radar alerts.
- Direct email from a venue (support inbox).
- Anomaly dashboards (auth failures, webhook signature failures).

## P0 response (the first 30 minutes)

1. **Declare.** Post in `#incidents` (Slack/Discord, even as solo — future you will want the log). Timestamp everything.
2. **Assess scope.** How many orgs affected? Is data exposed? Is money moving incorrectly? Is it still happening?
3. **Stop the bleed.** If there's a live data exposure: take the affected surface offline. For the widget: flip a kill-switch env var that serves a maintenance page. For the dashboard: Vercel rollback to the previous deployment. This is more important than fixing the root cause in the moment.
4. **Communicate.** Status page updated (`status.tablekit.uk`). Affected venues emailed within 1 hour for anything guest-visible.
5. **Preserve evidence.** Do not delete logs, don't run destructive cleanups, don't "clear" a table to reset. Screenshot Sentry, save webhook bodies, note PR/commit hashes.
6. **Fix.** Once the bleed is stopped, root-cause and fix. Claude Code can be asked to help — use `/plan` before `/ship`.
7. **Verify.** Confirm the fix holds on staging and on a single venue in prod before full rollout.

## Kill switches (implement these before launch)

- `WIDGET_DISABLED=true` — serves maintenance page to all widget traffic.
- `BOOKINGS_READ_ONLY=true` — prevents new bookings but allows dashboard viewing.
- `PAYMENTS_DISABLED=true` — routes all payment flows to "contact venue directly" message.
- `RWG_DISABLED=true` — returns 503 to Google's requests (they'll retry).
- `SMS_DISABLED=true` / `EMAIL_DISABLED=true` — pauses outbound messaging queues.

All kill switches are Vercel env vars — flipping takes ~30 seconds.

## Rollback procedure

- Vercel: `vercel rollback` to the previous deployment. Test on staging first if a DB migration is involved.
- Database migrations: **forward-only.** Never write destructive down-migrations. For emergencies, write a new compensating migration.
- Webhooks: Stripe will retry for 3 days. OK to drop incoming events during a 30-minute rollback — they'll be replayed.

## GDPR breach path

If the incident involves personal data exposure:
1. Follow the steps above to contain.
2. Within 24 hours: internal assessment (scope, categories, rough count, risk).
3. Within 72 hours of awareness: notify ICO if risk to rights/freedoms is non-negligible.
4. Notify affected organisations (controllers) as soon as practicable; they may need to notify their guests.
5. Document: what happened, when, scope, decisions taken, what's being changed. Filed in `incidents/YYYY-MM-DD-<slug>.md`.

See `gdpr.md` for the full breach path.

## Post-incident review

Within 7 days of resolution, write a post-mortem:
- Timeline (UTC timestamps).
- Impact: orgs affected, data involved, money, duration.
- Root cause (5 whys).
- What went well.
- What we'll change. Action items with owner (you) and due date.

Keep these in `incidents/` in the repo. Even solo. They compound into a checklist over time.

## On-call reality for a solo operator

You will not be online 24/7. That's fine. Set expectations:
- Status page says "single-operator service, best-effort support during UK business hours".
- Auto-responder on support email acknowledges with expected response time.
- Stripe handles the money-critical parts — even if the dashboard is down, payments mostly keep working via the webhook queue backfilling.
- Resend/Twilio will retry sends; guests eventually get their confirmations.

What you must monitor actively: payment processing (money), auth (access), RLS (data isolation). Everything else can wait a few hours.

## Useful commands during an incident

```bash
# Tail prod logs
pnpm logs:prod --tail

# Check webhook queue depth
pnpm jobs:status

# Snapshot a table for forensics
pnpm db:snapshot bookings --where "organisation_id = '...'"

# Flip a kill switch
vercel env add WIDGET_DISABLED production
# (then redeploy to pick it up)
```
