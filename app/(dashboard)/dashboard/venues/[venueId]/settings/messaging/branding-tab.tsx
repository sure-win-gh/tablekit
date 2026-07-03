"use client";

import Link from "next/link";
import { useActionState } from "react";

import { UpgradeBanner } from "@/components/billing/locked-feature";

import { updateBranding, type MessagingSettingsState } from "../messaging-actions";

const initial: MessagingSettingsState = { status: "idle" };

export type BrandingView = {
  logoUrl: string;
  brandColour: string;
  signature: string;
  replyTo: string;
  cornerStyle: string;
};

export function BrandingTab({
  venueId,
  branding,
  isPlus,
}: {
  venueId: string;
  branding: BrandingView;
  // Branding fields stay editable on every tier (they drive emails);
  // only their application to the widget is Plus-gated.
  isPlus: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateBranding, initial);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-4">
      <input type="hidden" name="venue_id" value={venueId} />
      <p className="text-ash text-xs">
        Applied to all guest emails, and — on Plus — to your booking page, embedded widget and
        payment screen. Leave blank for the default neutral style. SMS and WhatsApp stay plain text.
      </p>
      {!isPlus ? <UpgradeBanner feature="widgetTheming" /> : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink font-medium">Logo URL</span>
        <input
          name="logo_url"
          type="url"
          defaultValue={branding.logoUrl}
          placeholder="https://…/logo.png"
          className="border-hairline rounded-input border px-3 py-2 text-sm"
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
            className="border-hairline rounded-input border px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink font-medium">Reply-to email</span>
          <input
            name="reply_to"
            type="email"
            defaultValue={branding.replyTo}
            placeholder="hello@yourvenue.co.uk"
            className="border-hairline rounded-input border px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink font-medium">Widget corners</span>
        <select
          name="corner_style"
          defaultValue={branding.cornerStyle || "rounded"}
          className="border-hairline rounded-input border px-3 py-2 text-sm"
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
          className="border-hairline rounded-input border px-3 py-2 text-sm"
        />
      </label>
      <p className="text-ash text-xs">
        {isPlus
          ? "Your branding shows on your live booking widget."
          : "Add the booking widget to your website to start taking bookings."}{" "}
        <Link
          href={`/dashboard/venues/${venueId}/embed`}
          className="text-coral font-medium underline underline-offset-2"
        >
          Get your embed code &amp; booking link →
        </Link>
      </p>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="bg-ink rounded-input px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save branding"}
        </button>
        {state.status === "saved" ? <span className="text-sm text-emerald-600">Saved.</span> : null}
        {state.status === "error" ? (
          <span role="alert" className="text-rose text-sm">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
