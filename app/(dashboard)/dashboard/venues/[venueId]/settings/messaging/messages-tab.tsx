"use client";

import { ChevronDown, GripVertical } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";

import { cn } from "@/components/ui";

import {
  previewMessage,
  saveMessage,
  type MessageSaveState,
  type PreviewResult,
} from "../messaging-actions";

const initial: MessageSaveState = { status: "idle" };

const SUBJECT_MAX = 200;
const BODY_MAX = 2000;

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type CopyOverride = {
  subjectOverride: string | null;
  bodyOverride: string | null;
  enabled: boolean;
};

export type MessageRowView = {
  event: string;
  template: string;
  label: string;
  help: string;
  capableChannels: string[];
  timing: "before" | "after" | null;
  enabled: boolean;
  primary: string;
  secondary: string | null;
  hours: number | null;
  // channel → stored copy override (absent = default copy)
  overrides: Record<string, CopyOverride>;
};

function hasCustomCopy(row: MessageRowView): boolean {
  return Object.values(row.overrides).some(
    (o) => o.enabled && Boolean(o.bodyOverride || o.subjectOverride),
  );
}

function timingText(row: MessageRowView): string {
  if (!row.timing) return row.event === "cancelled" ? "on cancel" : "on confirmation";
  if (row.timing === "before") return `${row.hours ?? "—"}h before`;
  return `${row.hours ?? "—"}h after visit`;
}

function channelChain(row: MessageRowView): string {
  const parts = [CHANNEL_LABEL[row.primary] ?? row.primary];
  if (row.secondary) parts.push(CHANNEL_LABEL[row.secondary] ?? row.secondary);
  return parts.join(" → ");
}

export function MessagesTab({
  venueId,
  rows,
  mergeTags,
}: {
  venueId: string;
  rows: MessageRowView[];
  mergeTags: string[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="border-hairline rounded-card divide-hairline divide-y overflow-hidden border bg-white">
        {rows.map((row) => (
          <MessageRow
            key={row.event}
            venueId={venueId}
            row={row}
            mergeTags={mergeTags}
            open={expanded === row.event}
            onToggle={() => setExpanded(expanded === row.event ? null : row.event)}
          />
        ))}
      </div>
      <p className="text-ash text-xs">
        Email is always free · SMS and WhatsApp are charged at cost · WhatsApp only sends when the
        guest has a phone number on file.
      </p>
    </div>
  );
}

function MessageRow({
  venueId,
  row,
  mergeTags,
  open,
  onToggle,
}: {
  venueId: string;
  row: MessageRowView;
  mergeTags: string[];
  open: boolean;
  onToggle: () => void;
}) {
  const [state, formAction, pending] = useActionState(saveMessage, initial);

  // Copy editor state — per (row, channel); switching channel reloads
  // the stored override for that channel.
  const [copyChannel, setCopyChannel] = useState(row.primary);
  const stored = row.overrides[copyChannel];
  const [subject, setSubject] = useState(stored?.subjectOverride ?? "");
  const [body, setBody] = useState(stored?.bodyOverride ?? "");
  const [copyEnabled, setCopyEnabled] = useState(stored?.enabled ?? true);
  const [loadedChannel, setLoadedChannel] = useState(copyChannel);
  if (copyChannel !== loadedChannel) {
    const next = row.overrides[copyChannel];
    setSubject(next?.subjectOverride ?? "");
    setBody(next?.bodyOverride ?? "");
    setCopyEnabled(next?.enabled ?? true);
    setLoadedChannel(copyChannel);
  }

  // Re-opening a row reloads stored values, matching the uncontrolled
  // flow inputs (which reset on unmount) — no half-stale editors.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    if (open) {
      const cur = row.overrides[row.primary];
      setCopyChannel(row.primary);
      setLoadedChannel(row.primary);
      setSubject(cur?.subjectOverride ?? "");
      setBody(cur?.bodyOverride ?? "");
      setCopyEnabled(cur?.enabled ?? true);
    }
    setWasOpen(open);
  }

  // Only submit the copy override when it actually differs from what's
  // stored — an untouched editor must not write inert rows.
  const copyDirty =
    subject !== (stored?.subjectOverride ?? "") ||
    body !== (stored?.bodyOverride ?? "") ||
    copyEnabled !== (stored?.enabled ?? true);

  // Click-to-insert / drag-to-insert merge tags. Click drops the token
  // at the caret of whichever field was focused last (body by default);
  // drag uses the browser's native text/plain drop, which lands at the
  // pointer position and fires onChange on the controlled input.
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [lastFocused, setLastFocused] = useState<"subject" | "body">("body");

  const insertTag = (tag: string) => {
    const token = `{{${tag}}}`;
    const intoSubject = lastFocused === "subject" && copyChannel === "email";
    const target = intoSubject ? subjectRef.current : bodyRef.current;
    const current = intoSubject ? subject : body;
    const max = intoSubject ? SUBJECT_MAX : BODY_MAX;
    const start = target?.selectionStart ?? current.length;
    const end = target?.selectionEnd ?? start;
    const next = current.slice(0, start) + token + current.slice(end);
    if (next.length > max) return; // silently refuse rather than truncate a tag
    (intoSubject ? setSubject : setBody)(next);
    // Restore focus + put the caret just after the inserted token so
    // repeated clicks build a sentence naturally.
    requestAnimationFrame(() => {
      if (!target) return;
      target.focus();
      const pos = start + token.length;
      target.setSelectionRange(pos, pos);
    });
  };

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, startPreview] = useTransition();
  const runPreview = () =>
    startPreview(async () => {
      setPreview(
        await previewMessage({
          template: row.template,
          channel: copyChannel,
          subjectOverride: subject,
          bodyOverride: body,
        }),
      );
    });

  const custom = hasCustomCopy(row);

  return (
    <div className={cn(open && "bg-cloud/50")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", row.enabled ? "bg-coral" : "bg-stone")}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className={cn("text-sm font-semibold", row.enabled ? "text-ink" : "text-ash")}>
            {row.label}
          </span>
          <span className="text-ash ml-2 text-xs">{timingText(row)}</span>
        </span>
        <span className="text-ash hidden text-xs sm:inline">
          {row.enabled ? channelChain(row) : "off"}
        </span>
        {custom ? (
          <span className="rounded-pill border-coral/40 text-coral-deep bg-coral/5 border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap">
            Custom copy
          </span>
        ) : (
          <span className="text-ash hidden text-[11px] whitespace-nowrap sm:inline">
            Default copy
          </span>
        )}
        <ChevronDown
          className={cn("text-ash h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <form
          action={formAction}
          className="border-hairline flex flex-col gap-4 border-t px-4 py-4"
        >
          <input type="hidden" name="venue_id" value={venueId} />
          <input type="hidden" name="event" value={row.event} />
          <p className="text-ash text-xs">{row.help}</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <label className="flex items-center gap-2 text-sm sm:col-span-1">
              <input type="checkbox" name={`${row.event}_enabled`} defaultChecked={row.enabled} />
              <span className="text-charcoal">Send this message</span>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink text-xs font-medium">Preferred channel</span>
              <select
                name={`${row.event}_primary`}
                defaultValue={row.primary}
                className="border-hairline rounded-input border px-3 py-2 text-sm"
              >
                {row.capableChannels.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </label>
            {row.capableChannels.length > 1 ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">Fallback (optional)</span>
                <select
                  name={`${row.event}_secondary`}
                  defaultValue={row.secondary ?? "none"}
                  className="border-hairline rounded-input border px-3 py-2 text-sm"
                >
                  <option value="none">None</option>
                  {row.capableChannels.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {row.timing ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">
                  {row.timing === "before" ? "Hours before booking" : "Hours after finishing"}
                </span>
                <input
                  type="number"
                  name={`${row.event}_hours`}
                  defaultValue={row.hours ?? undefined}
                  min={1}
                  max={row.timing === "before" ? 168 : 72}
                  className="border-hairline rounded-input border px-3 py-2 text-sm"
                />
              </label>
            ) : null}
          </div>

          <div className="border-hairline border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink text-xs font-semibold">Copy</span>
              {row.capableChannels.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCopyChannel(c)}
                  aria-pressed={c === copyChannel}
                  className={cn(
                    "rounded-pill border px-2.5 py-0.5 text-[11px] font-semibold transition",
                    c === copyChannel
                      ? "border-ink bg-ink text-white"
                      : "border-hairline text-ash hover:text-ink bg-white",
                  )}
                >
                  {CHANNEL_LABEL[c] ?? c}
                </button>
              ))}
              <span className="text-ash text-[11px]">
                Blank = default wording. Unsubscribe (email) and STOP (SMS) lines are always added.
                Don&apos;t paste guest details.
              </span>
            </div>
            <input type="hidden" name="copy_channel" value={copyDirty ? copyChannel : ""} />

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {mergeTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  draggable
                  onClick={() => insertTag(t)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", `{{${t}}}`);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  title={`Click to insert at the cursor, or drag into the ${
                    copyChannel === "email" ? "subject or body" : "body"
                  }`}
                  className="bg-cloud rounded-tag text-charcoal hover:bg-hairline inline-flex cursor-grab items-center gap-0.5 px-1.5 py-0.5 font-mono text-xs transition active:cursor-grabbing"
                >
                  <GripVertical className="text-mute h-3 w-3" aria-hidden />
                  {`{{${t}}}`}
                </button>
              ))}
              <span className="text-ash text-[11px]">click or drag to insert</span>
            </div>

            {copyChannel === "email" ? (
              <label className="mt-2 flex flex-col gap-1 text-sm">
                <span className="text-ink text-xs font-medium">Subject</span>
                <input
                  ref={subjectRef}
                  name="subject_override"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onFocus={() => setLastFocused("subject")}
                  maxLength={SUBJECT_MAX}
                  placeholder="Leave blank for the default subject"
                  className="border-hairline rounded-input border px-3 py-2 text-sm"
                />
              </label>
            ) : null}

            <label className="mt-2 flex flex-col gap-1 text-sm">
              <span className="text-ink text-xs font-medium">Body</span>
              <textarea
                ref={bodyRef}
                name="body_override"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onFocus={() => setLastFocused("body")}
                rows={4}
                maxLength={BODY_MAX}
                placeholder="Leave blank to use the default copy — click or drag a tag above to insert it"
                className="border-hairline rounded-input border px-3 py-2 font-mono text-sm"
              />
            </label>

            <label className="mt-2 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                name="copy_enabled"
                checked={copyEnabled}
                onChange={(e) => setCopyEnabled(e.target.checked)}
              />
              <span className="text-charcoal">
                Use this override (untick to keep it but send the default)
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="bg-ink rounded-input px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save this message"}
            </button>
            <button
              type="button"
              onClick={runPreview}
              disabled={previewing}
              className="border-hairline rounded-input border px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {previewing ? "Rendering…" : `Preview ${CHANNEL_LABEL[copyChannel] ?? copyChannel}`}
            </button>
            {state.status === "saved" ? (
              <span className="text-sm text-emerald-600">Saved.</span>
            ) : null}
            {state.status === "error" ? (
              <span role="alert" className="text-rose text-sm">
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
            <div className="border-hairline rounded-card border bg-white p-3">
              <p className="text-ash mb-2 text-xs font-semibold tracking-wide uppercase">
                Preview — {CHANNEL_LABEL[copyChannel] ?? copyChannel}
              </p>
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
                    className="border-hairline h-96 w-full rounded-md border"
                  />
                </>
              ) : (
                <pre className="text-charcoal text-sm whitespace-pre-wrap">{preview.body}</pre>
              )}
            </div>
          ) : null}
          {preview && !preview.ok ? (
            <p role="alert" className="text-rose text-sm">
              {preview.message}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
