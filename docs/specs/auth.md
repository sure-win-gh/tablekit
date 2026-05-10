# Spec: Authentication, organisations, roles

**Status:** shipped (TOTP + invite flow deferred — see "Deferred" below)
**Depends on:** nothing (this is foundational)

## What we're building

Operator-side authentication and multi-tenant organisation model.
Guests never sign in — they book via a public widget. Supabase Auth
is the identity provider; this spec covers what the application
layer adds on top (organisations, memberships, roles, venue
scoping, audit, RLS).

## Entities

- `organisations` — a customer account; one billing subscription per org. Carries `plan` (free / core / plus), `wrapped_dek` for envelope encryption, `group_crm_enabled`.
- `users` — mirrors `auth.users` (Supabase) one-to-one via FK. Holds `email` (citext, unique) and `full_name` for display.
- `memberships` — user ↔ organisation, composite PK `(user_id, organisation_id)`. Carries `role` and an optional `venue_ids` array for per-venue scoping (NULL = "all venues in the org").
- `roles`: `owner` (full access + billing + API keys + webhooks), `manager` (operations across venues), `host` (day-of operations only, often venue-scoped).

## Auth flow

```
signup → email confirmation → first login → active-org cookie set → dashboard
```

- **Signup** (`app/(marketing)/signup/actions.ts`): a single server action creates the Supabase auth user, the public.users mirror, the organisation, and the owner membership. The transaction is admin-DB-scoped because RLS denies these tables to the unauthenticated role at create time. On success the action returns `status: "needs_confirm"`; the user clicks the link in the email Supabase sends.
- **Login** (`app/(marketing)/login`): Supabase password-grant. On success the cookie-bound Supabase session is set + the active-org cookie is initialised to the user's only (or first by created_at) membership.
- **Active-org cookie** (`lib/auth/active-org.ts`): a signed cookie storing the operator's current organisation_id. Read by `requireRole`, written when the user picks from the org switcher. Required because a user can hold multiple memberships (e.g. consultant managing two restaurants); RLS uses it to scope queries.

## Server-action gates

Three helpers compose into every authenticated server action:

- `requireRole(min)` (`lib/auth/require-role.ts`) — returns `{ userId, orgId, role }` or redirects to `/login`. Validates the active-org cookie + that the user has at least `min` role for that org. Role hierarchy is `owner > manager > host`, computed by `lib/auth/role-level.ts`.
- `requirePlan(orgId, min)` (`lib/auth/require-plan.ts`) — throws `InsufficientPlanError` if the org's plan is below `min` (`free < core < plus`). Plan-gated features (CRM, AI enquiries, public API, webhooks) consume this.
- `assertVenueVisible(venueId)` (`lib/auth/venue-scope.ts`) — for actions that take a `venueId` from a form, verifies the venue is in the caller's RLS-visible scope. Defends against a manager scoped to venue A crafting a request against venue B in the same org.

## Row-level security

Every tenant table has RLS enabled with at least one policy. The
application layer uses two SQL functions to keep policy bodies
one-hop:

- `public.user_organisation_ids()` — returns the orgs the JWT subject belongs to. Used by org-scoped policies.
- `public.user_visible_venue_ids()` — returns the venues the user can see, honouring per-venue `memberships.venue_ids` scoping. Used by venue-scoped tables (bookings, services, etc.).

Writes typically flow via `adminDb()` (service-role) after explicit
auth gating in server actions — the application enforces tenant
boundaries in code AND the DB enforces them via RLS, so a logic
bug in either layer doesn't open a cross-tenant leak. The
`scripts/check-rls.ts` guard runs in CI and fails the build if a
new public table lacks RLS or any policy.

Cross-tenant isolation is integration-tested in
`tests/integration/rls-cross-tenant.test.ts` (and per-resource
files: `rls-bookings`, `rls-deposits`, `rls-dsar`, `rls-enquiries`,
`rls-guests-per-venue`).

## User stories

- ✅ As a prospective operator I can sign up with email + password and be put into a fresh organisation as `owner`.
- ✅ As a user I can belong to multiple organisations (multiple memberships rows) and switch between them via the active-org cookie.
- ✅ As any user I can reset my password via Supabase's magic-link flow.
- ✅ As an owner I can invite a teammate by email; they get a signup link and are added with the role I specified. Pending invites + revoke surfaced at `/dashboard/organisation/team`.
- 🚧 As an owner/manager I must set up TOTP MFA. **Deferred — see below.**

## Acceptance criteria

- [x] Signup creates user, organisation, membership in one transaction.
- [x] Email verification required before first dashboard login (Supabase's confirm-email flow; signup action returns `needs_confirm` until the link is clicked).
- [x] Supabase Auth used as the identity provider.
- [x] Row-level security policies: a user can only read data for organisations they are a member of. Enforced at the DB layer via `public.user_organisation_ids()`.
- [x] Integration test proves RLS isolation across two organisations (`rls-cross-tenant.test.ts`).
- [x] Audit log entry on signup, `invite.created`, `invite.accepted`. (Revocation isn't audit-logged separately — `org_invitations.revoked_at` is the source of truth.) `role.changed`, `mfa.enrolled`, `mfa.disabled` action types pre-declared and wired when those flows ship.
- [x] **Invite flow with token + email + role assignment.** Owner-only invite form at `/dashboard/organisation/team`; SHA-256-hashed opaque token (72h expiry) emailed via Resend; `/invite/[token]` accept page handles new-user signup AND existing-user one-click accept. RLS verified by `tests/integration/rls-org-invitations.test.ts`.

## Invitations

`org_invitations` rows track the state of a pending team invite. The
plaintext token is 32 random bytes encoded base64url, emailed in the
accept URL; only its SHA-256 hash lives in the table. State machine:

```
pending  : accepted_at IS NULL AND revoked_at IS NULL
accepted : accepted_at IS NOT NULL  (one-shot)
revoked  : revoked_at IS NOT NULL
expired  : expires_at < now()       (no UPDATE — accept handler refuses)
```

A partial unique index on `(organisation_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` keeps duplicate live invites at bay; revoking + re-inviting is allowed.

Mutations (insert / update) flow through `adminDb()` in
[`app/(dashboard)/dashboard/organisation/team/actions.ts`](../../app/(dashboard)/dashboard/organisation/team/actions.ts) and
[`lib/auth/invitations.ts`](../../lib/auth/invitations.ts) after explicit
`requireRole("owner")` gating. RLS exposes only SELECT to org members
(no write policies for `authenticated`) — defence in depth.

The accept handler at `/invite/[token]`:

1. Resolves the token via SHA-256 lookup; rejects expired / accepted / revoked rows with a generic "no longer valid" message (no oracle for which reason).
2. New-user path: signs up through Supabase Auth at the invite-bound email (read-only on the form), then attaches the membership in a transaction that flips `accepted_at`.
3. Existing-user path: a single click joins the org if the signed-in email matches the invite email; mismatched signed-in users see "wrong account" and a sign-out prompt.
4. Audits `invite.accepted` with the role + email metadata.

## Data model (current)

The implementation evolved from the spec's starting point. The
fields below reflect what's in `lib/db/schema.ts` and active in
the DB.

```sql
create table organisations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                citext unique not null,
  plan                text not null default 'free',
  stripe_customer_id  text,
  wrapped_dek         bytea,                  -- envelope-encryption DEK (gdpr.md §Encryption)
  dek_version         integer not null default 1,
  group_crm_enabled   boolean not null default false,
  created_at          timestamptz not null default now()
);

create table users (
  id          uuid primary key,               -- mirrors auth.users.id (FK in migration)
  email       citext not null unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

create type org_role as enum ('owner','manager','host');

create table memberships (
  user_id          uuid not null references users(id) on delete cascade,
  organisation_id  uuid not null references organisations(id) on delete cascade,
  role             org_role not null,
  venue_ids        uuid[],                    -- NULL = all venues; non-NULL = scoped subset
  created_at       timestamptz not null default now(),
  primary key (user_id, organisation_id)
);
```

## RLS policies (representative)

```sql
-- One-hop helper: which orgs is the JWT subject in?
create function public.user_organisation_ids()
returns setof uuid
language sql security definer set search_path = public
as $$
  select organisation_id from memberships where user_id = auth.uid();
$$;

alter table organisations enable row level security;
create policy organisations_member_read on organisations
  for select to authenticated
  using (id in (select public.user_organisation_ids()));
```

The pattern repeats across every tenant-scoped table; venue-scoped
tables (e.g. `bookings`) use `user_visible_venue_ids()` instead.
See migration `0013_amusing_husk.sql` for the per-venue refinement
that made `memberships.venue_ids` load-bearing.

## Security notes

- Passwords via Supabase Auth (argon2id).
- Auth endpoints rate-limited at Cloudflare (anonymous; the app's per-IP and per-email limiters in `lib/public/rate-limit.ts` cover the application boundary).
- Magic-link password reset uses Supabase's signed token flow.
- Active-org cookie is HMAC-signed under `SESSION_SIGNING_SECRET` so an attacker can't forge an org_id by editing the cookie value.

## Out of scope

- SSO/SAML (year 2 when we sell to groups).
- Passkey/WebAuthn (after TOTP ships).
- Org-level audit log retention rules — currently 2 years per `gdpr.md` §Data categories and retention; sweeper TBD.
