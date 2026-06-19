import "server-only";

// Slack alerting for production issues we want to know about before a
// customer tells us. Posts to an Incoming Webhook URL held in
// SLACK_ALERT_WEBHOOK_URL.
//
// Mirrors the rate-limiter's posture: if the env var isn't set we
// no-op (local dev + CI stay silent), and a failed post never throws
// into the caller — alerting must not break the thing it's alerting
// about. A short timeout keeps a Slack outage from stalling a request
// or a cron run.

export type SlackAlert = {
  // One-line summary, shown in the notification.
  title: string;
  // Optional longer body.
  text?: string;
  level?: "info" | "warning" | "critical";
  // Structured fields rendered as a compact key/value list.
  fields?: Record<string, string | number>;
};

const LEVEL_EMOJI: Record<NonNullable<SlackAlert["level"]>, string> = {
  info: ":information_source:",
  warning: ":warning:",
  critical: ":rotating_light:",
};

/**
 * Send an alert to Slack. Resolves to true if delivered, false if it
 * was skipped (no webhook configured) or failed. Never rejects.
 */
export async function sendSlackAlert(alert: SlackAlert): Promise<boolean> {
  const webhook = process.env["SLACK_ALERT_WEBHOOK_URL"];
  if (!webhook) return false;

  const level = alert.level ?? "warning";
  const env = process.env["VERCEL_ENV"] ?? process.env["NODE_ENV"] ?? "unknown";

  const lines: string[] = [`${LEVEL_EMOJI[level]} *${alert.title}*  _(${env})_`];
  if (alert.text) lines.push(alert.text);
  if (alert.fields) {
    for (const [k, v] of Object.entries(alert.fields)) {
      lines.push(`• *${k}:* ${v}`);
    }
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
