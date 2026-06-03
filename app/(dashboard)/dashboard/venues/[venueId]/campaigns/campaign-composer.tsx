"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import {
  createCampaign,
  estimateCampaignAudience,
  previewCampaign,
  type CampaignPreview,
  type CreateCampaignState,
} from "./actions";

const initial: CreateCampaignState = { status: "idle" };

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type SegmentOption = { key: string; label: string };

function formatCost(pence: number): string {
  return pence === 0 ? "free" : `£${(pence / 100).toFixed(2)}`;
}

export function CampaignComposer({
  venueId,
  segments,
  initialEstimate,
  mergeTags,
}: {
  venueId: string;
  segments: SegmentOption[];
  initialEstimate: { count: number; costPence: number };
  mergeTags: string[];
}) {
  const [state, formAction, pending] = useActionState(createCampaign, initial);

  const [channel, setChannel] = useState("email");
  const [segment, setSegment] = useState("all");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");

  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [previewing, startPreview] = useTransition();

  // Audience estimate refetched whenever channel/segment changes.
  const [est, setEst] = useState(initialEstimate);
  const [estimating, startEstimate] = useTransition();
  useEffect(() => {
    let cancelled = false;
    startEstimate(async () => {
      const r = await estimateCampaignAudience({ venueId, channel, segment });
      if (!cancelled && r.ok) setEst({ count: r.count, costPence: r.costPence });
    });
    return () => {
      cancelled = true;
    };
  }, [venueId, channel, segment]);

  function runPreview() {
    startPreview(async () => {
      setPreview(await previewCampaign({ venueId, channel, subject, body }));
    });
  }

  return (
    <div className="border-hairline rounded-card flex max-w-2xl flex-col gap-4 border bg-white p-6">
      <div>
        <h2 className="text-ink text-base font-semibold">New campaign</h2>
        <p className="text-ash mt-1 text-xs">
          Broadcasts only reach guests who opted in to this channel for this venue. Email is free;
          SMS/WhatsApp are billed at cost.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="venue_id" value={venueId} />
        <input type="hidden" name="subject" value={subject} />
        <input type="hidden" name="body" value={body} />
        <input type="hidden" name="schedule_at" value={scheduleAt} />

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

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Channel</span>
            <select
              name="channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="border-hairline rounded-md border px-3 py-2 text-sm"
            >
              {Object.keys(CHANNEL_LABEL).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </label>

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
        </div>

        <p className="text-charcoal bg-cloud rounded-md px-3 py-2 text-sm">
          {estimating ? (
            <span className="text-ash">Estimating audience…</span>
          ) : (
            <>
              Estimated audience: <strong>{est.count}</strong> consented{" "}
              {est.count === 1 ? "guest" : "guests"} · estimated cost{" "}
              <strong>{formatCost(est.costPence)}</strong>
            </>
          )}
        </p>

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
          <button
            type="button"
            onClick={runPreview}
            disabled={previewing}
            className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {previewing ? "Rendering…" : "Preview"}
          </button>
          <button
            type="submit"
            name="send"
            value="draft"
            disabled={pending}
            className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Save draft
          </button>
          <button
            type="submit"
            name="send"
            value="now"
            disabled={pending}
            className="bg-ink rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending
              ? "Working…"
              : scheduleAt
                ? `Schedule (${est.count})`
                : `Send now (${est.count})`}
          </button>

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
