#!/usr/bin/env node
// =============================================================================
// Tablekit — local SaaS metrics dashboard generator
// =============================================================================
//
// Pulls subscription/revenue metrics from Stripe (platform account) and
// product-usage metrics from the Postgres DB, computes MRR / ARR / active &
// inactive users / churn / tool utilisation / growth, and writes a single
// self-contained `metrics-dashboard.html` you can double-click to open.
//
// Reuses the project's existing credentials from .env.local — no new config:
//   DATABASE_URL          (Supabase Postgres, pooler)
//   STRIPE_SECRET_KEY     (platform account)
//   STRIPE_PRICE_CORE     (recurring price id → plan "core")
//   STRIPE_PRICE_PLUS     (recurring price id → plan "plus")
//
// Run:
//   node scripts/metrics-dashboard/generate.mjs            # live
//   node scripts/metrics-dashboard/generate.mjs --sample   # offline demo data
//
// Output: scripts/metrics-dashboard/metrics-dashboard.html
//
// Notes
//  - Read-only. Issues SELECTs and Stripe list/retrieve calls only.
//  - Stripe is the source of truth for billing; Postgres for product usage.
//    MRR is derived from live Stripe subscriptions so it matches what you
//    actually bill, not the denormalised organisations.plan column.
//  - Plan list prices (VAT-exclusive) come from lib/marketing/tiers.ts:
//    free £0, core £29, plus £74. We read MRR from Stripe amounts, but fall
//    back to these list prices if a subscription item has no usable amount.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const OUT_PATH = join(__dirname, "metrics-dashboard.html");

const SAMPLE = process.argv.includes("--sample");

// VAT-exclusive monthly list prices, mirrored from lib/marketing/tiers.ts.
const LIST_PRICE = { free: 0, core: 29, plus: 74 };

// ---------------------------------------------------------------------------
// Tiny .env.local loader (avoids assuming dotenv import paths). Does not
// override anything already set in the real environment.
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  try {
    const raw = readFileSync(join(REPO_ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let [, k, v] = m;
      v = v.replace(/^["']|["']$/g, "");
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env.local — rely on process env */
  }
}

const isPlaceholder = (v) => !v || /YOUR_|YOUR_PROJECT|YOUR_DB_PASSWORD/.test(v);

const fmtGBP = (n) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n || 0);
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Stripe metrics — live subscriptions → MRR, ARR, plan mix, churn inputs.
// ---------------------------------------------------------------------------
async function stripeMetrics() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (isPlaceholder(key)) {
    return { ok: false, reason: "STRIPE_SECRET_KEY not set (placeholder).", mode: "test" };
  }
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(key);
  const mode = key.startsWith("sk_live") ? "live" : "test";

  // All non-terminal subscriptions, paginated.
  const subs = [];
  for await (const s of stripe.subscriptions.list({
    status: "all",
    expand: ["data.items.data.price"],
    limit: 100,
  })) {
    subs.push(s);
  }

  const priceToPlan = {
    [process.env.STRIPE_PRICE_CORE]: "core",
    [process.env.STRIPE_PRICE_PLUS]: "plus",
  };

  // Monthly normalisation of a Stripe recurring amount.
  const monthlyAmount = (price, qty = 1) => {
    if (!price || price.unit_amount == null) return null;
    const each = price.unit_amount / 100;
    const interval = price.recurring?.interval || "month";
    const count = price.recurring?.interval_count || 1;
    let monthly = each;
    if (interval === "year") monthly = each / (12 * count);
    else if (interval === "week") monthly = (each * 52) / 12 / count;
    else if (interval === "day") monthly = (each * 365) / 12 / count;
    else monthly = each / count; // month
    return monthly * qty;
  };

  const planMix = { core: 0, plus: 0, other: 0 };
  let mrr = 0;
  let trialing = 0;
  let pastDue = 0;
  let activeCount = 0;
  let canceledCount = 0;
  const now = Date.now() / 1000;
  const last30 = now - 30 * 86400;
  let canceled30 = 0;
  let activeAt30dStart = 0; // active subs that existed 30d ago (denominator-ish)

  for (const s of subs) {
    const counted = s.status === "active" || s.status === "trialing" || s.status === "past_due";
    if (s.status === "trialing") trialing++;
    if (s.status === "past_due") pastDue++;
    if (s.status === "canceled") {
      canceledCount++;
      if ((s.canceled_at || s.ended_at || 0) >= last30) canceled30++;
    }
    if (counted) {
      activeCount++;
      let subMonthly = 0;
      let detectedPlan = null;
      for (const item of s.items?.data || []) {
        const amt = monthlyAmount(item.price, item.quantity || 1);
        const plan = priceToPlan[item.price?.id];
        if (plan) detectedPlan = plan;
        if (amt != null) subMonthly += amt;
      }
      if (!subMonthly && detectedPlan) subMonthly = LIST_PRICE[detectedPlan] || 0;
      // Trials contribute £0 to current MRR (not yet billing).
      if (s.status !== "trialing") mrr += subMonthly;
      const key = detectedPlan && planMix[detectedPlan] != null ? detectedPlan : "other";
      planMix[key]++;
    }
    // Was this sub active 30 days ago? (created before the window AND
    // not canceled before it). Rough denominator for churn rate.
    if ((s.created || 0) <= last30) {
      const stoppedBefore = s.status === "canceled" && (s.canceled_at || s.ended_at || 0) < last30;
      if (!stoppedBefore) activeAt30dStart++;
    }
  }

  const churn30 = activeAt30dStart > 0 ? canceled30 / activeAt30dStart : null;

  return {
    ok: true,
    mode,
    mrr,
    arr: mrr * 12,
    activeCount,
    trialing,
    pastDue,
    canceledCount,
    planMix,
    churn30,
    canceled30,
    activeAt30dStart,
    paying: activeCount - trialing,
  };
}

// ---------------------------------------------------------------------------
// Postgres metrics — active/inactive orgs & users, tool utilisation, growth.
// ---------------------------------------------------------------------------
async function pgMetrics() {
  const url = process.env.DATABASE_URL;
  if (isPlaceholder(url)) {
    return { ok: false, reason: "DATABASE_URL not set (placeholder)." };
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const q = async (text, params = []) => (await client.query(text, params)).rows;
  const one = async (text, params = []) => (await q(text, params))[0] || {};

  try {
    // Activity definition: an org is "active" if it has had a booking created
    // in the last 30 days. Otherwise inactive. (Tunable in one place.)
    const ACTIVE_WINDOW_DAYS = 30;

    const orgTotals = await one(`
      select
        count(*)::int                                              as total_orgs,
        count(*) filter (where plan = 'free')::int                 as free_orgs,
        count(*) filter (where plan = 'core')::int                 as core_orgs,
        count(*) filter (where plan = 'plus')::int                 as plus_orgs,
        count(*) filter (where created_at >= now() - interval '30 days')::int as new_orgs_30d
      from organisations
    `);

    const activeOrgs = await one(
      `
      with recent as (
        select distinct organisation_id
        from bookings
        where created_at >= now() - ($1 || ' days')::interval
      )
      select
        (select count(*) from recent)::int as active_orgs,
        (select count(*) from organisations)::int as total_orgs
      `,
      [ACTIVE_WINDOW_DAYS],
    );

    const users = await one(`
      with active_user as (
        select distinct m.user_id
        from memberships m
        where m.organisation_id in (
          select distinct organisation_id from bookings
          where created_at >= now() - interval '30 days'
        )
      )
      select
        (select count(*) from users)::int as total_users,
        (select count(*) from active_user)::int as active_users
    `);

    // Growth: new orgs per month for the last 6 months.
    const signups = await q(`
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
             count(*)::int as n
      from organisations
      where created_at >= date_trunc('month', now()) - interval '5 months'
      group by 1 order by 1
    `);

    // Bookings per month (product engagement) for last 6 months.
    const bookingsByMonth = await q(`
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
             count(*)::int as n
      from bookings
      where created_at >= date_trunc('month', now()) - interval '5 months'
      group by 1 order by 1
    `);

    // Tool / feature utilisation: distinct orgs that have used each surface.
    // "Used" = has at least one row of the relevant kind.
    const helper = async (label, sqlText, params = []) => {
      try {
        const r = await one(sqlText, params);
        return { label, orgs: Number(r.n || 0) };
      } catch {
        // Table may not exist in this DB yet — report as unavailable (null).
        return { label, orgs: null };
      }
    };

    const tools = [];
    tools.push(
      await helper("Bookings", `select count(distinct organisation_id)::int n from bookings`),
    );
    tools.push(
      await helper(
        "Deposits / payments",
        `select count(distinct organisation_id)::int n from payments where status = 'succeeded' and amount_minor > 0`,
      ),
    );
    tools.push(
      await helper(
        "SMS reminders",
        `select count(distinct organisation_id)::int n from messages where channel = 'sms' and status in ('sent','delivered')`,
      ),
    );
    tools.push(
      await helper("Reviews", `select count(distinct organisation_id)::int n from reviews`),
    );
    tools.push(
      await helper(
        "Marketing campaigns",
        `select count(distinct organisation_id)::int n from campaigns where status <> 'draft'`,
      ),
    );
    tools.push(
      await helper(
        "AI enquiry handler",
        `select count(distinct organisation_id)::int n from enquiries`,
      ),
    );
    tools.push(
      await helper("Waitlist", `select count(distinct organisation_id)::int n from waitlists`),
    );
    tools.push(
      await helper(
        "Reserve w/ Google",
        `select count(distinct organisation_id)::int n from venue_oauth_connections where provider = 'google'`,
      ),
    );
    tools.push(
      await helper(
        "Public API keys",
        `select count(distinct organisation_id)::int n from api_keys`,
      ),
    );
    tools.push(
      await helper(
        "Webhooks",
        `select count(distinct organisation_id)::int n from webhook_subscriptions`,
      ),
    );
    tools.push(
      await helper(
        "POS integration",
        `select count(distinct organisation_id)::int n from pos_connections`,
      ),
    );

    // Messaging usage (current month) — volume + estimated cost in pence.
    let messageUsage = null;
    try {
      messageUsage = await q(`
        select channel, sum(count)::int as sends, sum(est_cost_pence)::bigint as cost_pence
        from message_usage
        where period = to_char(now(), 'YYYY-MM')
        group by channel order by channel
      `);
    } catch {
      messageUsage = null;
    }

    // Bookings in last 30 days (raw activity headline).
    const bookings30 = await one(
      `select count(*)::int n from bookings where created_at >= now() - interval '30 days'`,
    );

    return {
      ok: true,
      activeWindowDays: ACTIVE_WINDOW_DAYS,
      totalOrgs: orgTotals.total_orgs ?? 0,
      free: orgTotals.free_orgs ?? 0,
      core: orgTotals.core_orgs ?? 0,
      plus: orgTotals.plus_orgs ?? 0,
      newOrgs30d: orgTotals.new_orgs_30d ?? 0,
      activeOrgs: activeOrgs.active_orgs ?? 0,
      inactiveOrgs: (orgTotals.total_orgs ?? 0) - (activeOrgs.active_orgs ?? 0),
      totalUsers: users.total_users ?? 0,
      activeUsers: users.active_users ?? 0,
      inactiveUsers: (users.total_users ?? 0) - (users.active_users ?? 0),
      signups,
      bookingsByMonth,
      tools,
      messageUsage,
      bookings30: bookings30.n ?? 0,
    };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Sample data (offline) so the dashboard layout can be reviewed without creds.
// ---------------------------------------------------------------------------
function sampleData() {
  const months = lastSixMonths();
  return {
    generatedAt: new Date().toISOString(),
    sample: true,
    stripe: {
      ok: true,
      mode: "test",
      mrr: 2117,
      arr: 2117 * 12,
      activeCount: 61,
      paying: 55,
      trialing: 6,
      pastDue: 2,
      canceledCount: 9,
      planMix: { core: 43, plus: 12, other: 0 },
      churn30: 0.031,
      canceled30: 2,
      activeAt30dStart: 58,
    },
    pg: {
      ok: true,
      activeWindowDays: 30,
      totalOrgs: 214,
      free: 153,
      core: 47,
      plus: 14,
      newOrgs30d: 18,
      activeOrgs: 132,
      inactiveOrgs: 82,
      totalUsers: 268,
      activeUsers: 161,
      inactiveUsers: 107,
      signups: months.map((m, i) => ({ month: m, n: [9, 12, 15, 11, 21, 18][i] })),
      bookingsByMonth: months.map((m, i) => ({
        month: m,
        n: [820, 1010, 1340, 1180, 1620, 1755][i],
      })),
      tools: [
        { label: "Bookings", orgs: 198 },
        { label: "Deposits / payments", orgs: 71 },
        { label: "SMS reminders", orgs: 88 },
        { label: "Reviews", orgs: 54 },
        { label: "Marketing campaigns", orgs: 22 },
        { label: "AI enquiry handler", orgs: 9 },
        { label: "Waitlist", orgs: 41 },
        { label: "Reserve w/ Google", orgs: 33 },
        { label: "Public API keys", orgs: 7 },
        { label: "Webhooks", orgs: 5 },
        { label: "POS integration", orgs: 3 },
      ],
      messageUsage: [
        { channel: "email", sends: 9120, cost_pence: 0 },
        { channel: "sms", sends: 3410, cost_pence: 13640 },
        { channel: "whatsapp", sends: 410, cost_pence: 2050 },
      ],
      bookings30: 1755,
    },
  };
}

function lastSixMonths() {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 5; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML rendering — single file, Chart.js from CDN, no external CSS.
// ---------------------------------------------------------------------------
function renderHTML(data) {
  const s = data.stripe;
  const p = data.pg;
  const gen = new Date(data.generatedAt);

  const card = (label, value, sub = "", accent = "") =>
    `<div class="card">
       <div class="card-label">${label}</div>
       <div class="card-value ${accent}">${value}</div>
       <div class="card-sub">${sub}</div>
     </div>`;

  // KPI cards (graceful when a source is unavailable).
  const cards = [];
  if (s?.ok) {
    cards.push(card("MRR", fmtGBP(s.mrr), `Stripe ${s.mode} mode · ${s.paying} paying`, "pos"));
    cards.push(card("ARR", fmtGBP(s.arr), "MRR × 12", "pos"));
    cards.push(
      card("Active subscriptions", s.activeCount, `${s.trialing} trialing · ${s.pastDue} past due`),
    );
    cards.push(
      card(
        "Monthly churn",
        pct(s.churn30),
        `${s.canceled30} cancelled / ${s.activeAt30dStart} base`,
        s.churn30 && s.churn30 > 0.05 ? "neg" : "",
      ),
    );
  } else {
    cards.push(card("MRR / ARR / Churn", "—", s?.reason || "Stripe unavailable", "muted"));
  }
  if (p?.ok) {
    cards.push(
      card(
        "Active venues",
        p.activeOrgs,
        `of ${p.totalOrgs} · booked in ${p.activeWindowDays}d`,
        "pos",
      ),
    );
    cards.push(
      card(
        "Inactive venues",
        p.inactiveOrgs,
        "no bookings in window",
        p.inactiveOrgs > p.activeOrgs ? "neg" : "",
      ),
    );
    cards.push(card("Active users", p.activeUsers, `of ${p.totalUsers} total`));
    cards.push(
      card(
        "New venues (30d)",
        p.newOrgs30d,
        `${p.bookings30.toLocaleString()} bookings in 30d`,
        "pos",
      ),
    );
  } else {
    cards.push(card("Usage metrics", "—", p?.reason || "Postgres unavailable", "muted"));
  }

  // Plan mix — prefer Stripe paying mix, fall back to org plan column.
  const planMix = s?.ok
    ? { Core: s.planMix.core, Plus: s.planMix.plus, Other: s.planMix.other }
    : p?.ok
      ? { Free: p.free, Core: p.core, Plus: p.plus }
      : {};

  const toolsRows = (p?.ok ? p.tools : [])
    .slice()
    .sort((a, b) => (b.orgs ?? -1) - (a.orgs ?? -1))
    .map((t) => {
      const denom = p.totalOrgs || 1;
      const share = t.orgs == null ? null : t.orgs / denom;
      const barW = share == null ? 0 : Math.round(share * 100);
      const val =
        t.orgs == null
          ? '<span class="muted">n/a</span>'
          : `${t.orgs} <span class="muted">(${(share * 100).toFixed(0)}%)</span>`;
      return `<tr>
        <td>${t.label}</td>
        <td class="num">${val}</td>
        <td class="barcell"><div class="bar" style="width:${barW}%"></div></td>
      </tr>`;
    })
    .join("");

  const usageRows = (p?.ok && p.messageUsage ? p.messageUsage : [])
    .map(
      (m) =>
        `<tr><td>${m.channel}</td><td class="num">${Number(m.sends).toLocaleString()}</td><td class="num">${fmtGBP(Number(m.cost_pence) / 100)}</td></tr>`,
    )
    .join("");

  const months = p?.ok ? p.signups.map((r) => r.month) : [];
  const signupSeries = p?.ok ? p.signups.map((r) => r.n) : [];
  const bookingMonths = p?.ok ? p.bookingsByMonth.map((r) => r.month) : [];
  const bookingSeries = p?.ok ? p.bookingsByMonth.map((r) => r.n) : [];

  const banner = data.sample
    ? `<div class="banner">Showing <strong>sample data</strong> — run <code>node scripts/metrics-dashboard/generate.mjs</code> against live credentials to populate real numbers.</div>`
    : !s?.ok || !p?.ok
      ? `<div class="banner">Partial data: ${[!s?.ok ? "Stripe" : null, !p?.ok ? "Postgres" : null].filter(Boolean).join(" + ")} source unavailable.</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tablekit — Business Metrics</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root{
    --bg:#0b0f1a; --panel:#141a2a; --panel2:#1b2237; --line:#26304a;
    --text:#e8edf7; --muted:#8b97b3; --accent:#5b8def; --pos:#34d399; --neg:#f87171;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f5f7fb; --panel:#ffffff; --panel2:#f0f3fa;
      --line:#e3e9f4; --text:#10182b; --muted:#647089; --accent:#2f6bed; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1120px;margin:0 auto;padding:32px 24px 64px;}
  header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;}
  h1{font-size:22px;margin:0;letter-spacing:-.2px;}
  .gen{color:var(--muted);font-size:13px;}
  .banner{background:var(--panel2);border:1px solid var(--line);border-radius:10px;
    padding:10px 14px;margin:16px 0;color:var(--muted);font-size:13px;}
  .banner code{color:var(--accent);}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0 8px;}
  @media(max-width:780px){.grid{grid-template-columns:repeat(2,1fr);}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;}
  .card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;}
  .card-value{font-size:28px;font-weight:650;margin-top:6px;letter-spacing:-.5px;}
  .card-sub{color:var(--muted);font-size:12.5px;margin-top:4px;}
  .pos{color:var(--pos);} .neg{color:var(--neg);} .muted{color:var(--muted);}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px;}
  @media(max-width:880px){.panels{grid-template-columns:1fr;}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;}
  .panel h2{font-size:14px;margin:0 0 14px;font-weight:600;}
  table{width:100%;border-collapse:collapse;font-size:13.5px;}
  th{ text-align:left;color:var(--muted);font-weight:500;font-size:12px;padding:0 8px 8px;border-bottom:1px solid var(--line);}
  td{padding:8px;border-bottom:1px solid var(--line);}
  td.num{text-align:right;white-space:nowrap;}
  .barcell{width:34%;}
  .bar{height:8px;border-radius:6px;background:linear-gradient(90deg,var(--accent),#8db4ff);min-width:2px;}
  canvas{max-height:240px;}
  footer{color:var(--muted);font-size:12px;margin-top:28px;text-align:center;}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Tablekit · Business Metrics</h1>
    <div class="gen">Generated ${gen.toLocaleString("en-GB")} ${s?.ok ? `· Stripe ${s.mode}` : ""}</div>
  </header>
  ${banner}

  <div class="grid">${cards.join("")}</div>

  <div class="panels">
    <div class="panel">
      <h2>New venues per month</h2>
      <canvas id="signups"></canvas>
    </div>
    <div class="panel">
      <h2>Bookings per month</h2>
      <canvas id="bookings"></canvas>
    </div>
  </div>

  <div class="panels">
    <div class="panel">
      <h2>Plan mix</h2>
      <canvas id="planmix"></canvas>
    </div>
    <div class="panel">
      <h2>Tool utilisation <span class="muted">(venues using each feature)</span></h2>
      <table>
        <thead><tr><th>Feature</th><th class="num">Venues</th><th>Adoption</th></tr></thead>
        <tbody>${toolsRows || `<tr><td colspan="3" class="muted">No usage data.</td></tr>`}</tbody>
      </table>
    </div>
  </div>

  ${
    usageRows
      ? `<div class="panels"><div class="panel">
      <h2>Messaging usage this month</h2>
      <table><thead><tr><th>Channel</th><th class="num">Sends</th><th class="num">Est. cost</th></tr></thead>
      <tbody>${usageRows}</tbody></table>
    </div><div class="panel">
      <h2>Notes</h2>
      <p class="muted" style="font-size:13px;line-height:1.6;">
      MRR &amp; churn come from live Stripe subscriptions (source of truth for billing).
      Active venue = a booking created in the last ${p?.ok ? p.activeWindowDays : 30} days.
      Tool utilisation counts distinct venues with at least one row for that feature.
      Re-run the generator to refresh.</p>
    </div></div>`
      : ""
  }

  <footer>Tablekit metrics · read-only snapshot · regenerate with <code>node scripts/metrics-dashboard/generate.mjs</code></footer>
</div>

<script>
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#2f6bed';
  const muted = css.getPropertyValue('--muted').trim() || '#888';
  const line = css.getPropertyValue('--line').trim() || '#ddd';
  Chart.defaults.color = muted;
  Chart.defaults.borderColor = line;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const months = ${JSON.stringify(months)};
  const signups = ${JSON.stringify(signupSeries)};
  const bMonths = ${JSON.stringify(bookingMonths)};
  const bookings = ${JSON.stringify(bookingSeries)};
  const planMix = ${JSON.stringify(planMix)};

  if (document.getElementById('signups') && months.length) {
    new Chart(document.getElementById('signups'), {
      type:'bar',
      data:{labels:months,datasets:[{data:signups,backgroundColor:accent,borderRadius:6}]},
      options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}
    });
  }
  if (document.getElementById('bookings') && bMonths.length) {
    new Chart(document.getElementById('bookings'), {
      type:'line',
      data:{labels:bMonths,datasets:[{data:bookings,borderColor:accent,backgroundColor:'rgba(91,141,239,.15)',fill:true,tension:.3,pointRadius:3}]},
      options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}
    });
  }
  const pmLabels = Object.keys(planMix), pmVals = Object.values(planMix);
  if (document.getElementById('planmix') && pmVals.some(v=>v>0)) {
    new Chart(document.getElementById('planmix'), {
      type:'doughnut',
      data:{labels:pmLabels,datasets:[{data:pmVals,
        backgroundColor:['#6b7280','#5b8def','#34d399','#f59e0b']}]},
      options:{plugins:{legend:{position:'bottom'}},cutout:'62%'}
    });
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  loadEnvLocal();

  let data;
  if (SAMPLE) {
    data = sampleData();
  } else {
    const [stripe, pg] = await Promise.allSettled([stripeMetrics(), pgMetrics()]);
    data = {
      generatedAt: new Date().toISOString(),
      sample: false,
      stripe:
        stripe.status === "fulfilled"
          ? stripe.value
          : { ok: false, reason: String(stripe.reason).slice(0, 200) },
      pg:
        pg.status === "fulfilled"
          ? pg.value
          : { ok: false, reason: String(pg.reason).slice(0, 200) },
    };
  }

  const html = renderHTML(data);
  writeFileSync(OUT_PATH, html, "utf8");

  // Console summary.
  const s = data.stripe,
    p = data.pg;
  console.log("\n  Tablekit metrics dashboard");
  console.log("  --------------------------------");
  if (s?.ok) {
    console.log(`  MRR        ${fmtGBP(s.mrr)}   ARR ${fmtGBP(s.arr)}`);
    console.log(
      `  Subs       ${s.activeCount} active (${s.trialing} trial, ${s.pastDue} past due)`,
    );
    console.log(`  Churn 30d  ${pct(s.churn30)}  (${s.canceled30}/${s.activeAt30dStart})`);
  } else {
    console.log(`  Stripe     unavailable — ${s?.reason}`);
  }
  if (p?.ok) {
    console.log(
      `  Venues     ${p.activeOrgs} active / ${p.inactiveOrgs} inactive (${p.totalOrgs} total)`,
    );
    console.log(`  Users      ${p.activeUsers} active / ${p.totalUsers} total`);
  } else {
    console.log(`  Postgres   unavailable — ${p?.reason}`);
  }
  console.log(`\n  Wrote ${OUT_PATH}\n`);
})().catch((e) => {
  console.error("Generator failed:", e);
  process.exit(1);
});
