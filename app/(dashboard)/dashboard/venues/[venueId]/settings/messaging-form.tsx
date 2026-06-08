"use client";

import { useActionState } from "react";

import { UpgradeBanner } from "@/components/billing/locked-feature";

import { updateMessagingSettings, type MessagingSettingsState } from "./messaging-actions";

const initial: MessagingSettingsState = { status: "idle" };

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export type FlowEventView = {
  event: string;
  label: string;
  help: string;
  capableChannels: string[];
  timing: "before" | "after" | null;
  enabled: boolean;
  primary: string;
  secondary: string | null;
  hours: number | null;
};

type Props = {
  venueId: string;
  events: FlowEventView[];
  branding: {
    logoUrl: string;
    brandColour: string;
    signature: string;
    replyTo: string;
    cornerStyle: string;
  };
  // Whether the org is on Plus — controls the widget-theming upsell. The
  // branding fields stay editable regardless (they drive emails on every
  // tier); only their application to the widget is Plus-gated.
  isPlus: boolean;
};

export function MessagingSettingsForm({ venueId, events, branding, isPlus }: Props) {
  const [state, formAction, pending] = useActionState(updateMessagingSettings, initial);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-5">
      <input type="hidden" name="venue_id" value={venueId} />

      <div>
        <h2 className="text-ink text-base font-semibold">Messaging &amp; automation</h2>
        <p className="text-ash mt-1 text-xs">
          Choose which lifecycle messages send, on which channel, and when. WhatsApp only sends if
          the guest has a phone number on file. Email is always free; SMS/WhatsApp are charged at
          cost.
        </p>
      </div>

      {events.map((ev) => (
        <fieldset key={ev.event} className="border-hairline flex flex-col gap-2 border-t pt-4">
          <legend className="text-ink text-sm font-semibold">{ev.label}</legend>
          <p className="text-ash text-xs">{ev.help}</p>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name={`${ev.event}_enabled`} defaultChecked={ev.enabled} />
            <span className="text-charcoal">Send this message</span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink font-medium">Preferred channel</span>
              <select
                name={`${ev.event}_primary`}
                defaultValue={ev.primary}
                className="border-hairline rounded-md border px-3 py-2 text-sm"
              >
                {ev.capableChannels.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </label>

            {ev.capableChannels.length > 1 ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink font-medium">Fallback (optional)</span>
                <select
                  name={`${ev.event}_secondary`}
                  defaultValue={ev.secondary ?? "none"}
                  className="border-hairline rounded-md border px-3 py-2 text-sm"
                >
                  <option value="none">None</option>
                  {ev.capableChannels.map((c) => (
                    <option key={c} value={c}>
                      {CHANNEL_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {ev.timing ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-ink font-medium">
                  {ev.timing === "before" ? "Hours before booking" : "Hours after finishing"}
                </span>
                <input
                  type="number"
                  name={`${ev.event}_hours`}
                  defaultValue={ev.hours ?? undefined}
                  min={1}
                  max={ev.timing === "before" ? 168 : 72}
                  className="border-hairline rounded-md border px-3 py-2 text-sm"
                />
              </label>
            ) : null}
          </div>
        </fieldset>
      ))}

      <fieldset className="border-hairline flex flex-col gap-3 border-t pt-4">
        <legend className="text-ink text-sm font-semibold">Branding</legend>
        <p className="text-ash text-xs">
          Applied to all guest emails, and — on Plus — to your booking page, embedded widget and
          payment screen. Leave blank for the default neutral style. SMS and WhatsApp stay plain
          text.
        </p>
        {!isPlus ? <UpgradeBanner feature="widgetTheming" /> : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Logo URL</span>
          <input
            name="logo_url"
            type="url"
            defaultValue={branding.logoUrl}
            placeholder="https://…/logo.png"
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Accent colour (hex)</span>
            <input
              name="brand_colour"
              type="text"
              defaultValue={branding.brandColour}
              placeholder="#c2410c"
              className="border-hairline rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink font-medium">Reply-to email</span>
            <input
              name="reply_to"
              type="email"
              defaultValue={branding.replyTo}
              placeholder="hello@yourvenue.co.uk"
              className="border-hairline rounded-md border px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Widget corners</span>
          <select
            name="corner_style"
            defaultValue={branding.cornerStyle || "rounded"}
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          >
            <option value="rounded">Rounded (default)</option>
            <option value="sharp">Sharp</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Email signature</span>
          <textarea
            name="signature"
            defaultValue={branding.signature}
            maxLength={500}
            rows={2}
            placeholder="The team at Your Venue"
            className="border-hairline rounded-md border px-3 py-2 text-sm"
          />
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-ink rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save messaging settings"}
        </button>
        {state.status === "saved" ? <span className="text-sm text-green-600">Saved.</span> : null}
        {state.status === "error" ? (
          <span role="alert" className="text-sm text-red-600">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
