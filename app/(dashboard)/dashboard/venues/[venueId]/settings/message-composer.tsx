"use client";

import { useActionState, useMemo, useState, useTransition } from "react";

import {
  previewMessage,
  upsertMessageTemplate,
  type OverrideState,
  type PreviewResult,
} from "./messaging-actions";

const initial: OverrideState = { status: "idle" };

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type OverrideSlot = { template: string; label: string; channels: string[] };
export type OverrideRow = {
  template: string;
  channel: string;
  subjectOverride: string | null;
  bodyOverride: string | null;
  enabled: boolean;
};

type Props = {
  venueId: string;
  slots: OverrideSlot[];
  overrides: OverrideRow[];
  mergeTags: string[];
};

export function MessageComposer({ venueId, slots, overrides, mergeTags }: Props) {
  const [state, formAction, pending] = useActionState(upsertMessageTemplate, initial);

  const [template, setTemplate] = useState(slots[0]?.template ?? "");
  const channelsFor = useMemo(
    () => slots.find((s) => s.template === template)?.channels ?? [],
    [slots, template],
  );
  const [channel, setChannel] = useState(channelsFor[0] ?? "email");

  // Prefill from an existing override when the (template, channel) pair changes.
  const existing = overrides.find((o) => o.template === template && o.channel === channel);
  const [subject, setSubject] = useState(existing?.subjectOverride ?? "");
  const [body, setBody] = useState(existing?.bodyOverride ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);

  // Track which (template, channel) the local draft reflects so switching
  // selects reloads the stored override.
  const [loadedKey, setLoadedKey] = useState(`${template}:${channel}`);
  const key = `${template}:${channel}`;
  if (key !== loadedKey) {
    const next = overrides.find((o) => o.template === template && o.channel === channel);
    setSubject(next?.subjectOverride ?? "");
    setBody(next?.bodyOverride ?? "");
    setEnabled(next?.enabled ?? true);
    setLoadedKey(key);
  }

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, startPreview] = useTransition();

  function runPreview() {
    startPreview(async () => {
      const r = await previewMessage({
        template,
        channel,
        subjectOverride: subject,
        bodyOverride: body,
      });
      setPreview(r);
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 border-t pt-6">
      <div>
        <h2 className="text-ink text-base font-semibold">Message copy</h2>
        <p className="text-ash mt-1 text-xs">
          Override the wording of any message. Leave blank to use the default. The unsubscribe link
          (email) and STOP line (SMS) are always added automatically and can&apos;t be removed.
          Don&apos;t paste guest details here.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Message</span>
          <select
            value={template}
            onChange={(e) => {
              const t = e.target.value;
              setTemplate(t);
              const chs = slots.find((s) => s.template === t)?.channels ?? [];
              if (!chs.includes(channel)) setChannel(chs[0] ?? "email");
            }}
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          >
            {slots.map((s) => (
              <option key={s.template} value={s.template}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Channel</span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          >
            {channelsFor.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </label>
      </div>

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
            placeholder="Leave blank for the default subject"
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          />
        </label>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink font-medium">Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          maxLength={2000}
          placeholder="Leave blank to use the default copy"
          className="border-hairline rounded-md border px-3 py-2 font-mono text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-charcoal">
          Use this override (untick to keep it but send the default)
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={runPreview}
          disabled={previewing}
          className="border-hairline rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {previewing ? "Rendering…" : "Preview"}
        </button>

        <form action={formAction}>
          <input type="hidden" name="venue_id" value={venueId} />
          <input type="hidden" name="template" value={template} />
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="subject_override" value={subject} />
          <input type="hidden" name="body_override" value={body} />
          {enabled ? <input type="hidden" name="enabled" value="on" /> : null}
          <button
            type="submit"
            disabled={pending}
            className="bg-ink rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save copy"}
          </button>
        </form>

        {state.status === "saved" ? <span className="text-sm text-green-600">Saved.</span> : null}
        {state.status === "error" ? (
          <span role="alert" className="text-sm text-red-600">
            {state.message}
          </span>
        ) : null}
      </div>

      {state.status === "saved" && state.unknownTags.length > 0 ? (
        <p className="text-xs text-amber-600">
          Heads up — unrecognised tags will appear literally: {state.unknownTags.join(", ")}
        </p>
      ) : null}

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
