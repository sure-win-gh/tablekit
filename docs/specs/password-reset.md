# Spec: Password reset

**Status:** Draft (security audit P2 — requirement #2).

## Depends on

- `docs/specs/auth.md` — accounts, Supabase Auth, the invitation token pattern this mirrors.
- `docs/playbooks/gdpr.md` — token rows reference a user; email is PII; logs carry no plaintext.
- `docs/playbooks/security.md` — auth-endpoint rate limits (5/IP/15min, 3/account/hour).

## What we're building

A self-service password reset that we own end to end, rather than leaning on Supabase's
dashboard-configured recovery link. A user who forgot their password asks for a reset from
the login page, receives an email with a single-use link that expires in 15 minutes, and sets
a new password. We mint and verify the token in our own code (so the TTL and single-use rule
are version-controlled and tested); Supabase only performs the final password write.

## User stories

- As an operator who forgot my password, I can request a reset link from the login page.
- As an operator, I can follow that link within 15 minutes and set a new password.
- As an operator, I cannot reuse a reset link once it has set a password.
- As a stranger, I cannot tell from the response whether an email belongs to a real account.

## Data model

```sql
-- Platform-level (not tenant-scoped), mirroring outreach_claims. The plaintext
-- token lives only in the emailed URL; we persist its SHA-256 hash. No email
-- column — user_id is enough, and storing less PII is the point.
create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,             -- sha256 hex of the base64url token
  expires_at  timestamptz not null,             -- now() + 15 min
  used_at     timestamptz,                       -- single-use: set on successful reset
  created_at  timestamptz not null default now()
);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id);

-- RLS in the SAME migration. Deny-all to authenticated + anon; every read/write
-- goes through adminDb() from the server actions (same posture as outreach_claims).
alter table password_reset_tokens enable row level security;
create policy password_reset_tokens_no_access on password_reset_tokens
  for all to authenticated using (false) with check (false);
```

At most one live (unused) token per user: minting deletes any prior unused rows for that
user first, enforced in `lib/auth/password-reset.ts` (mirrors `lib/auth/invitations.ts`).

## API surface

- **Page** `app/(marketing)/forgot-password/page.tsx` — email field; linked from `/login`.
- **Action** `requestPasswordReset(email)` in `app/(marketing)/forgot-password/actions.ts`:
  Zod-validate → rate-limit (IP 5/15min + per-email-hash 3/hour, reusing
  `lib/public/rate-limit.ts` with the P1 peek-on-success pattern) → resolve email→user via
  `adminDb` → if found: invalidate prior unused tokens, mint a new one (32 random bytes,
  base64url), email the link via `lib/email/send.ts` → **always** return the same neutral
  result. Audit `password_reset.requested`.
- **Page** `app/(marketing)/reset-password/page.tsx` — reads `?token=`, shows the new-password form.
- **Action** `resetPassword(token, newPassword)` in `app/(marketing)/reset-password/actions.ts`:
  Zod-validate password (min 12, max 128 — matches signup) → resolve token by hash to a live
  row (unused, unexpired) → in one transaction mark `used_at` and call Supabase
  `auth.admin.updateUserById(userId, { password })` → revoke the user's other sessions
  (`auth.admin.signOut`) → audit `password_reset.completed` → redirect to `/login`.
- **Token helpers** `lib/auth/password-reset.ts` — `mintResetToken`, `resolveResetToken`,
  `consumeResetToken`; SHA-256 hashing, never logs plaintext (copies `invitations.ts`).
- **Email template** `lib/email/templates/password-reset.tsx` — link + 15-min notice. The send
  wrapper carries only a bland error code, never the raw SDK error (`gdpr.md` §logs).
- **Cleanup** a daily Vercel cron deletes `used_at`-set or expired rows older than 24h.

## Acceptance criteria

- [ ] Requesting a reset for an unknown email returns the **same** neutral response as a known
      one, and creates **no** token row (no account enumeration).
- [ ] A valid token sets a new password exactly once; a second use of the same token fails.
- [ ] A token older than 15 minutes is rejected.
- [ ] Minting a new reset invalidates any prior unused token for that user.
- [ ] Only the SHA-256 hash is persisted; the plaintext token never lands in the DB or logs.
- [ ] Both actions are rate-limited (5/IP/15min and 3/email/hour) via the Upstash limiter.
- [ ] The new password must meet the signup policy (≥12 chars); weaker passwords are rejected.
- [ ] On successful reset, the user's other Supabase sessions are revoked.
- [ ] `password_reset_tokens` denies all access to `authenticated`/`anon` — proven by an RLS
      integration test (CLAUDE.md rule 3).
- [ ] `password_reset.requested` and `password_reset.completed` are written to the audit log.
- [ ] `/login` links to `/forgot-password`; happy path covered by a Playwright smoke test.

## Marketing impact

- **Customer-visible:** no (internal/infra — auth).

## Out of scope

- Changing your password while logged in (a separate `/dashboard/settings/security` flow).
- Passkey/WebAuthn and SSO/SAML (tracked in `auth.md` out-of-scope).
- Magic-link login (already exists) and email-address change.
