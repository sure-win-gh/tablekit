"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import { TOPUP_AMOUNTS_PENCE } from "@/lib/billing/topup-amounts";

import { startTopup } from "../../../organisation/billing/topup-actions";
import { DOC_VERSION, type CampaignBodyDoc, type DocTheme } from "@/lib/campaigns/blocks";

import {
  createCampaign,
  estimateCampaignAudience,
  previewCampaign,
  sendTestCampaignEmail,
  type CampaignPreview,
  type CreateCampaignState,
  type EmailBillingEstimate,
} from "./actions";
import { EmailBuilder, ThemePanel, newBlock, toDocBlocks, type EditorBlock } from "./email-builder";
import { LivePreview } from "./live-preview";

const initial: CreateCampaignState = { status: "idle" };

export type SegmentOption = { key: string; label: string };

export type AudienceEstimate = {
  count: number;
  costPence: number;
  emailBilling: EmailBillingEstimate | null;
};

function formatCost(pence: number): string {
  return pence === 0 ? "free" : `£${(pence / 100).toFixed(2)}`;
}

export function CampaignComposer({
  venueId,
  brandColour,
  channel,
  channelLabel,
  segments,
  canSegment,
  initialEstimate,
  initialBalancePence,
  mergeTags,
}: {
  venueId: string;
  brandColour: string | null;
  channel: string;
  channelLabel: string;
  segments: SegmentOption[];
  canSegment: boolean;
  initialEstimate: AudienceEstimate;
  initialBalancePence: number;
  mergeTags: string[];
}) {
  const [state, formAction, pending] = useActionState(createCampaign, initial);

  const [segment, setSegment] = useState("all");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");

  // Email builder (marketing-suite Phase A): block mode is the default
  // email experience; plain mode remains for quick text sends and is the
  // only mode for SMS/WhatsApp.
  const [mode, setMode] = useState<"blocks" | "plain">("blocks");
  const [blocks, setBlocks] = useState<EditorBlock[]>([newBlock("heading"), newBlock("text")]);
  const [theme, setTheme] = useState<DocTheme>({});
  const builderActive = channel === "email" && mode === "blocks";
  const docBlocks = builderActive ? toDocBlocks(blocks) : [];
  // Only store theme keys the operator actually set — an absent theme
  // means "venue branding + defaults" and keeps the doc minimal.
  const setThemeKeys = Object.fromEntries(
    Object.entries(theme).filter(([, v]) => v !== undefined),
  ) as DocTheme;
  const bodyDoc: CampaignBodyDoc | null =
    builderActive && docBlocks.length > 0
      ? {
          v: DOC_VERSION,
          ...(Object.keys(setThemeKeys).length > 0 ? { theme: setThemeKeys } : {}),
          blocks: docBlocks,
        }
      : null;

  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewing, startPreview] = useTransition();
  const [testState, setTestState] = useState<string | null>(null);
  const [testing, startTest] = useTransition();

  // Audience estimate + current credit balance, refetched whenever
  // channel/segment changes.
  const [est, setEst] = useState<AudienceEstimate>(initialEstimate);
  const [balancePence, setBalancePence] = useState(initialBalancePence);
  const [estimating, startEstimate] = useTransition();
  useEffect(() => {
    let cancelled = false;
    startEstimate(async () => {
      const r = await estimateCampaignAudience({ venueId, channel, segment });
      if (!cancelled && r.ok) {
        setEst({ count: r.count, costPence: r.costPence, emailBilling: r.emailBilling });
        setBalancePence(r.balancePence);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [venueId, channel, segment]);

  // Prepaid gate: a paid campaign (cost > 0) can only send if the balance
  // covers it. Email overage only gates once enforcement is on — during
  // the display-only rollout the cost is shown but nothing is charged.
  const emailBilling = channel === "email" ? est.emailBilling : null;
  const costApplies = channel !== "email" || (emailBilling?.enforced ?? false);
  const insufficientCredit = costApplies && est.costPence > balancePence;

  function runPreview() {
    startPreview(async () => {
      setPreview(
        await previewCampaign({
          venueId,
          channel,
          subject,
          body,
          ...(bodyDoc ? { bodyDoc } : {}),
        }),
      );
    });
  }

  function runTestSend() {
    setTestState(null);
    startTest(async () => {
      const r = await sendTestCampaignEmail({
        venueId,
        subject,
        body,
        ...(bodyDoc ? { bodyDoc } : {}),
      });
      setTestState(r.ok ? `Test sent to ${r.to}.` : r.message);
    });
  }

  return (
    <div
      className={`border-hairline rounded-card flex flex-col gap-4 border bg-white p-6 ${builderActive ? "" : "max-w-2xl"}`}
    >
      <div>
        <h2 className="text-ink text-base font-semibold">New {channelLabel} campaign</h2>
        <p className="text-ash mt-1 text-xs">
          Broadcasts only reach guests who opted in to this channel for this venue.
        </p>
      </div>

      {/* Builder mode is a Kit-style split pane: compose on the left,
          the real rendered email updating live on the right. */}
      <div
        className={
          builderActive ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "contents"
        }
      >
        <form action={formAction} className="flex min-w-0 flex-col gap-4">
          <input type="hidden" name="venue_id" value={venueId} />
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="subject" value={subject} />
          <input type="hidden" name="body" value={body} />
          <input type="hidden" name="schedule_at" value={scheduleAt} />
          <input type="hidden" name="body_doc" value={bodyDoc ? JSON.stringify(bodyDoc) : ""} />

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Campaign name</span>
            <input
              name="name"
              required
              maxLength={120}
              placeholder="June supper club"
              className="border-hairline rounded-md border px-3 py-2 text-sm"
            />
          </label>

          {canSegment ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink font-medium">Audience</span>
              <select
                name="segment"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
                className="border-hairline rounded-md border px-3 py-2 text-sm"
              >
                {segments.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              {/* Segments are a Plus feature — Core sends to all consented guests. */}
              <input type="hidden" name="segment" value="all" />
              <p className="text-ash text-xs">
                Audience: all consented guests. Targeting segments (New, Regular, Lapsed, VIP) is a
                Plus feature.
              </p>
            </>
          )}

          <p className="text-charcoal bg-cloud rounded-md px-3 py-2 text-sm">
            {estimating ? (
              <span className="text-ash">Estimating audience…</span>
            ) : emailBilling ? (
              <>
                Estimated audience: <strong>{est.count}</strong> consented{" "}
                {est.count === 1 ? "guest" : "guests"} ·{" "}
                <strong>{Math.min(est.count, emailBilling.remaining)}</strong> within your monthly
                allowance ({emailBilling.remaining} of {emailBilling.allowance} left)
                {emailBilling.chargeable > 0 ? (
                  <>
                    {" "}
                    · <strong>{emailBilling.chargeable}</strong> chargeable ≈{" "}
                    <strong>{formatCost(est.costPence)}</strong>
                    {emailBilling.enforced ? (
                      <>
                        {" "}
                        · credit balance <strong>{formatCost(balancePence)}</strong>
                      </>
                    ) : (
                      <span className="text-ash">
                        {" "}
                        (overage billing not yet active — free today)
                      </span>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <>
                Estimated audience: <strong>{est.count}</strong> consented{" "}
                {est.count === 1 ? "guest" : "guests"} · estimated cost{" "}
                <strong>{formatCost(est.costPence)}</strong>
                {est.costPence > 0 ? (
                  <>
                    {" "}
                    · credit balance <strong>{formatCost(balancePence)}</strong>
                  </>
                ) : null}
              </>
            )}
          </p>

          {insufficientCredit ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900">
              <p>
                Not enough messaging credit to send this campaign (need {formatCost(est.costPence)},
                balance {formatCost(balancePence)}). You can still save it as a draft. Top up to
                send:
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {TOPUP_AMOUNTS_PENCE.map((amt) => (
                  <form key={amt} action={startTopup.bind(null, amt)}>
                    <input
                      type="hidden"
                      name="return_to"
                      value={`/dashboard/venues/${venueId}/campaigns`}
                    />
                    <button
                      type="submit"
                      className="border-hairline rounded-md border bg-white px-3 py-1.5 text-xs font-semibold hover:border-amber-600"
                    >
                      Top up {formatCost(amt)}
                    </button>
                  </form>
                ))}
              </div>
            </div>
          ) : null}

          <div className="text-ash flex flex-wrap gap-1.5 text-xs">
            <span className="text-charcoal font-medium">Merge tags:</span>
            {mergeTags.map((t) => (
              <code key={t} className="bg-cloud rounded px-1.5 py-0.5">{`{{${t}}}`}</code>
            ))}
          </div>

          {channel === "email" ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink font-medium">Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="Leave blank for a default subject"
                className="border-hairline rounded-md border px-3 py-2 text-sm"
              />
            </label>
          ) : null}

          {channel === "email" ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-ink font-medium">Content</span>
              <div className="border-hairline flex w-fit gap-0.5 rounded-md border p-0.5">
                {(["blocks", "plain"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={
                      mode === m
                        ? "bg-ink rounded px-2.5 py-1 text-xs font-semibold text-white"
                        : "text-ash hover:text-charcoal rounded px-2.5 py-1 text-xs font-medium"
                    }
                  >
                    {m === "blocks" ? "Design with blocks" : "Plain text"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {builderActive ? (
            <div className="flex flex-col gap-3">
              <ThemePanel theme={theme} onChange={setTheme} brandColour={brandColour} />
              <EmailBuilder
                venueId={venueId}
                blocks={blocks}
                onChange={setBlocks}
                theme={theme}
                brandColour={brandColour}
              />
              <span className="text-ash text-xs">
                The unsubscribe link is added automatically and can&apos;t be removed.
              </span>
            </div>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink font-medium">Message</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                maxLength={2000}
                placeholder="Hi {{guestFirstName}}, we'd love to see you at {{venueName}}…"
                className="border-hairline rounded-md border px-3 py-2 font-mono text-sm"
              />
              <span className="text-ash text-xs">
                The unsubscribe link (email) and STOP line (SMS/WhatsApp) are added automatically.
              </span>
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Schedule (optional)</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="border-hairline w-fit rounded-md border px-3 py-2 text-sm"
            />
            <span className="text-ash text-xs">
              Leave blank to send immediately. Scheduled sends are drained by a daily job.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            {!builderActive ? (
              <button
                type="button"
                onClick={runPreview}
                disabled={previewing}
                className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {previewing ? "Rendering…" : "Preview"}
              </button>
            ) : null}
            {channel === "email" ? (
              <button
                type="button"
                onClick={runTestSend}
                disabled={testing || (builderActive && !bodyDoc)}
                title="Send this draft to your own email — doesn't count towards your allowance"
                className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {testing ? "Sending…" : "Send test to me"}
              </button>
            ) : null}
            <button
              type="submit"
              name="send"
              value="draft"
              disabled={pending || (builderActive && !bodyDoc)}
              className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Save draft
            </button>
            <button
              type="submit"
              name="send"
              value="now"
              disabled={pending || insufficientCredit || (builderActive && !bodyDoc)}
              title={insufficientCredit ? "Top up messaging credit to send" : undefined}
              className="bg-ink rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending
                ? "Working…"
                : scheduleAt
                  ? `Schedule (${est.count})`
                  : `Send now (${est.count})`}
            </button>
            {testState ? <span className="text-ash text-sm">{testState}</span> : null}

            {state.status === "created" ? (
              <span className="text-sm text-green-600">
                {state.sent
                  ? scheduleAt
                    ? `Scheduled ${state.queued} sends.`
                    : `Queued ${state.queued} sends.`
                  : "Draft saved."}
              </span>
            ) : null}
            {state.status === "error" ? (
              <span role="alert" className="text-sm text-red-600">
                {state.message}
              </span>
            ) : null}
          </div>
        </form>

        {builderActive ? (
          <LivePreview venueId={venueId} subject={subject} bodyDoc={bodyDoc} />
        ) : null}
      </div>

      {preview && preview.ok ? (
        <div className="border-hairline rounded-md border p-3">
          <p className="text-ash mb-2 text-xs font-semibold tracking-wide uppercase">Preview</p>
          {preview.unknownTags.length > 0 ? (
            <p className="mb-2 text-xs text-amber-600">
              Unrecognised tags: {preview.unknownTags.join(", ")}
            </p>
          ) : null}
          {preview.kind === "email" ? (
            <>
              <p className="text-charcoal mb-2 text-sm">
                <span className="font-medium">Subject:</span> {preview.subject}
              </p>
              <iframe
                title="Email preview"
                srcDoc={preview.html}
                sandbox=""
                className="h-96 w-full rounded border"
              />
            </>
          ) : (
            <pre className="text-charcoal text-sm whitespace-pre-wrap">{preview.body}</pre>
          )}
        </div>
      ) : null}
      {preview && !preview.ok ? (
        <p role="alert" className="text-sm text-red-600">
          {preview.message}
        </p>
      ) : null}
    </div>
  );
}
