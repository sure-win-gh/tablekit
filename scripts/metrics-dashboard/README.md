# Tablekit metrics dashboard

A local, read-only business dashboard: MRR, ARR, active/inactive venues & users,
churn, plan mix, and tool utilisation. Pulls billing from **Stripe** (source of
truth for subscriptions) and product usage from **Postgres** (Supabase), then
writes a single self-contained `metrics-dashboard.html` you open in a browser.

## Run

```bash
# Live — reads DATABASE_URL + STRIPE_SECRET_KEY + STRIPE_PRICE_* from .env.local
node scripts/metrics-dashboard/generate.mjs

# Offline demo with realistic sample numbers (no credentials needed)
node scripts/metrics-dashboard/generate.mjs --sample
```

Open `scripts/metrics-dashboard/metrics-dashboard.html`. Re-run to refresh.

## What each metric means

- **MRR / ARR** — summed from live Stripe recurring subscriptions, normalised to
  monthly. Trials count as £0 until they convert. ARR = MRR × 12.
- **Active subscriptions** — Stripe subs in `active`, `trialing`, or `past_due`.
- **Monthly churn** — subs cancelled in the last 30 days ÷ subs active 30 days ago.
- **Active venue** — an organisation with a booking created in the last 30 days.
  Everything else is inactive. Window is one constant (`ACTIVE_WINDOW_DAYS`).
- **Active users** — members of any active venue.
- **Tool utilisation** — distinct venues with ≥1 row for each feature (bookings,
  deposits, SMS, reviews, campaigns, AI enquiries, waitlist, Reserve with Google,
  API, webhooks, POS). Missing tables report `n/a` rather than erroring.

## Notes

- Read-only: SELECTs and Stripe list/retrieve only. Never writes.
- No new dependencies — reuses `stripe` and `pg`, already in the project.
- Credentials stay in `.env.local` (per CLAUDE.md rule 10). The generated HTML
  contains no secrets, but it does contain real MRR/churn/org figures, so the
  live output `metrics-dashboard.html` is git-ignored — do not commit it. The
  committed `metrics-dashboard-sample.html` (offline `--sample` snapshot) is the
  only version in the repo.
- To automate: add a Vercel cron or a local `launchd`/cron entry that runs the
  script and uploads the HTML to a private location (not the repo).
