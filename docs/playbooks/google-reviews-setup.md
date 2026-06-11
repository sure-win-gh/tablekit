# Playbook: Setting up Google reviews sync

**What this enables:** importing a venue's Google reviews into Tablekit so they show on the booking page (rich Core+ page) and the dashboard reviews list, aggregated with internal reviews.

**How it works (already built):** an operator connects their **Google Business Profile** via OAuth on **Settings → Google**, picks their business location, and a nightly cron (`/api/cron/deposit-janitor`, 03:00 UTC) pulls reviews into the `reviews` table with `source = "google"` (`lib/google/sync-reviews.ts`). There's also a manual **"Sync now"** button. Tokens are stored envelope-encrypted; Google Business Profile is an **approved sub-processor** in `gdpr.md`.

> **The two things people miss** (both silently produce "no reviews"):
> 1. The OAuth client isn't configured in the environment (Part C).
> 2. **Business Profile API access must be *requested and approved* by Google** — enabling the API in the console is not enough (Part A.3). This is the most common blocker.

---

## Part 0 — Prerequisite: a verified Google Business Profile

Google reviews only exist if the venue has a **Google Business Profile** (the business listing on Google Search/Maps, formerly "Google My Business"). The API reads reviews **from that profile**, owned/managed by the connecting Google account.

- **No Business Profile = no Google reviews to sync** (and the API returns "business profile not found"). This is expected, not a bug.
- Create/claim one (free) at <https://business.google.com> → add your business → **verify** it (postcard / phone / email / video, depending on the business). Verification can take a few days.
- The connecting Google account must be an **Owner or Manager** of the profile.
- If a venue has no Google presence and you don't want one, **skip Google reviews** — internal reviews + the manual TripAdvisor badge still work.

You cannot complete Part A.3 (API access request) without an existing, verified Business Profile, because the request is tied to one.

---

## Part A — Google Cloud project + APIs

### 1. Create / pick a project
<https://console.cloud.google.com> → project picker → **New Project** (e.g. "Tablekit Reviews"). Use the Google account that owns/manages the Business Profile.

### 2. Enable the three Business Profile APIs
APIs & Services → **Enable APIs and Services** → enable each (the code calls all three — `lib/google/business-profile.ts`):
- **Google My Business API** (`mybusiness.googleapis.com`) — serves **reviews** (v4). *Access-restricted (see A.3).*
- **My Business Account Management API** (`mybusinessaccountmanagement.googleapis.com`) — lists accounts.
- **My Business Business Information API** (`mybusinessbusinessinformation.googleapis.com`) — lists locations.

### 3. ⚠️ Request access to the Business Profile APIs
The Google My Business API (v4) has **no default quota** — calls return **403** until Google grants access.
- Submit the **Business Profile APIs access request form**: <https://support.google.com/business/contact/api_default> (prereqs: <https://developers.google.com/my-business/content/prereqs>).
- Provide the **GCP project number**, the Google account, and a short use case ("import our own business reviews into our booking platform").
- Approval is **manual** — typically a few days to a couple of weeks. Until then, connecting works but the review pull 403s.

---

## Part B — OAuth consent screen + client

### 1. OAuth consent screen
APIs & Services → **OAuth consent screen**:
- **User type: External**; app name, support email, developer contact.
- **Scope:** add `https://www.googleapis.com/auth/business.manage` (the only scope Tablekit requests).
- While in **Testing**, add your Google account under **Test users**. For external operators in production, **submit for verification** (`business.manage` is a sensitive scope).

### 2. OAuth client
APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**:
- **Authorized redirect URIs** — add **exactly** (must equal `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`, fixed in `lib/oauth/google.ts`):
  - Dev: `http://localhost:3000/api/oauth/google/callback`
  - Prod: `https://YOUR-DOMAIN/api/oauth/google/callback`
- Copy the **Client ID** + **Client secret**.

---

## Part C — Tablekit environment

```
GOOGLE_OAUTH_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
# GOOGLE_OAUTH_SCOPES is optional — defaults to business.manage
```
- **Dev:** add to `.env.local`, restart `pnpm dev`.
- **Prod:** add in Vercel → Project → Settings → Environment Variables (Production), then redeploy.

This flips `isConfigured()` → true so `/api/oauth/google/start` stops returning `503 google-oauth-disabled`.

---

## Part D — Connect a venue (per venue, in the dashboard)

1. **Settings → Google** on the venue → **Connect Google** → approve consent.
2. Redirected back with `?google=connected`; the page lists your Google accounts + locations — **pick the venue's location** (sets `external_account_id`). *Reviews won't sync until a location is picked.*
3. **Sync now**, or wait for the 03:00 UTC cron.
4. Reviews appear on the booking page + dashboard.

---

## Part E — Verifying & troubleshooting

| Symptom | Cause / fix |
|---|---|
| **"Business profile not found"** / no accounts to pick | No verified Google Business Profile under the connecting account (**Part 0**), or the account isn't an Owner/Manager of it. |
| "Connect" does nothing / 503 `google-oauth-disabled` | Env not set (Part C), dev not restarted / prod not redeployed. |
| `redirect_uri_mismatch` | Authorized redirect URI ≠ `${NEXT_PUBLIC_APP_URL}/api/oauth/google/callback`. |
| `access_denied` / consent blocked | Account not added as a **Test user**, or scope missing (Part B.1). |
| Connected + location picked, but **0 reviews** / "Sync now" → `api-403` | **Business Profile API access not approved yet** (Part A.3) — the #1 cause. |
| `no-location` | Connected but no location picked (Part D.2). |

DB confirmation: a `venue_oauth_connections` row (provider `google`, non-null `external_account_id`, future `token_expires_at`) and a populating `last_synced_at`; `reviews` rows with `source = 'google'`.

---

## Code references
- OAuth: `lib/oauth/google.ts`, `app/api/oauth/google/{start,callback}/route.ts`
- API client: `lib/google/business-profile.ts` (accounts/locations/reviews)
- Sync: `lib/google/sync-reviews.ts`; cron `app/api/cron/deposit-janitor/route.ts`
- Dashboard: `app/(dashboard)/dashboard/venues/[venueId]/settings/google/` + `google-actions.ts`
- Compliance: `docs/playbooks/gdpr.md` (Google sub-processor; tokens encrypted)
