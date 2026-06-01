// Marketing render layer — campaign copy → channel payload.
//
// Like lib/messaging/render-message.tsx but guest-scoped (no booking).
// A smaller merge-tag set (guest first name + venue name), the same safe
// interpolation + React escaping, and the same always-applied opt-out:
// the email unsubscribe footer (via EmailLayout) and the SMS/WhatsApp
// STOP line cannot be edited away.

import "server-only";

import { render } from "@react-email/render";

import { EmailLayout, P } from "@/lib/email/templates/_layout";
import type {
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  VenueBranding,
} from "@/lib/messaging/context";
import { ensureOptOut, findUnknownTags, interpolateTemplate } from "@/lib/messaging/merge-tags";
import type { MessageChannel } from "@/lib/messaging/registry";

export type CampaignContext = {
  guestFirstName: string;
  venueName: string;
  unsubscribeUrl: string;
  branding?: VenueBranding | undefined;
};

const MARKETING_TAGS: Record<string, (c: CampaignContext) => string> = {
  guestFirstName: (c) => c.guestFirstName,
  venueName: (c) => c.venueName,
};

export const MARKETING_TAG_NAMES = Object.keys(MARKETING_TAGS);

function interpolate(template: string, ctx: CampaignContext): string {
  return interpolateTemplate(template, (name) => MARKETING_TAGS[name]?.(ctx));
}

export function findUnknownMarketingTags(template: string): string[] {
  return findUnknownTags(template, (name) => name in MARKETING_TAGS);
}

export type CampaignRendered =
  | { kind: "email"; rendered: RenderedEmail }
  | { kind: "sms"; rendered: RenderedSms }
  | { kind: "whatsapp"; rendered: RenderedWhatsApp };

export async function renderCampaign(input: {
  channel: MessageChannel;
  subject: string | null;
  body: string;
  ctx: CampaignContext;
}): Promise<CampaignRendered> {
  const body = interpolate(input.body, input.ctx);

  if (input.channel === "sms") {
    return { kind: "sms", rendered: { body: ensureOptOut(body) } };
  }
  if (input.channel === "whatsapp") {
    return { kind: "whatsapp", rendered: { body: ensureOptOut(body) } };
  }

  const subject = input.subject
    ? interpolate(input.subject, input.ctx)
    : `News from ${input.ctx.venueName}`;
  const paras = body.split(/\n{2,}/);
  const element = (
    <EmailLayout
      preview={subject}
      unsubscribeUrl={input.ctx.unsubscribeUrl}
      venueName={input.ctx.venueName}
      branding={input.ctx.branding}
    >
      {paras.map((p, i) => (
        <P key={i}>{p}</P>
      ))}
    </EmailLayout>
  );
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { kind: "email", rendered: { subject, html, text } };
}
