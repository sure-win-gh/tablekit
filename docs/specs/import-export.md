# Spec: Import from competitors, export anytime

**Status:** draft (MVP has export; import is early-Plus)
**Depends on:** `guests.md`, `bookings.md`

## What we're building

Zero-friction onboarding by importing guest lists and upcoming bookings from OpenTable, ResDiary, SevenRooms, Quandoo, Resy exports. And a comprehensive export so operators never feel locked in.

## Why this matters

Switching cost is the #1 objection from operators on incumbent platforms. If we can get their guest history in and get them up and running in 30 minutes, we remove the biggest friction point. The counterpart — "export anything, anytime" — is what lets them say yes without fear.

## Import (Plus tier)

### Supported sources (launch set)

1. **OpenTable** — exported guest list CSV.
2. **ResDiary** — exported guest list CSV.
3. **SevenRooms** — exported guest list CSV.
4. **Generic CSV** — column mapping wizard.

Not launch: live API imports from these platforms (terms often prohibit, and files are good enough).

### Flow

1. Operator uploads CSV in dashboard.
2. We detect format by column headers.
3. Column mapping wizard confirms mapping (with overrides).
4. Preview shows 10 rows pre-import.
5. Import runs as a background job. Operator sees progress and summary.
6. Dedupe by email+phone hash within the organisation. Conflicting rows → latest wins for notes, unions for tags.
7. Marketing consent is **never imported as granted** — the legal basis didn't transfer. Operator must re-opt-in.

### Acceptance criteria (import)

- [ ] CSVs up to 50k rows import within 5 minutes.
- [ ] Dedupe runs during import, not as a separate step.
- [ ] Imported guests have `imported_from` + `imported_at` metadata for provenance.
- [ ] Marketing consent flags always null on import.
- [ ] Rejected rows (missing required fields, malformed email) exported to a downloadable report.
- [ ] Job is resumable — crash mid-import doesn't double-insert.

## Export (MVP)

Available from day one on every tier. This is the promise.

### Exports available

- All bookings (JSON + CSV).
- All guests (JSON + CSV).
- All messages (JSON).
- All payments (CSV, with Stripe IDs for reconciliation).
- Full org backup (one zip, all of the above + schema documentation).

### Acceptance criteria (export)

- [ ] Available from dashboard Settings → Data.
- [ ] Full backup export runs as a background job; link emailed when ready.
- [ ] Encrypted PII columns are **decrypted in the export** (the owning org has the right to see their own data).
- [ ] Exports logged in `audit_log`.
- [ ] Export URL signed, single-use, expires after 24h.
