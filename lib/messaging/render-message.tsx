// Override-aware render entry point used by the dispatch worker.
//
// If the venue has a content override for (template, channel), render
// the operator's copy through the safe merge-tag interpolator; the
// unsubscribe footer (email, via EmailLayout) and STOP line (SMS) are
// always re-applied so an override can't strip the legally-required
// opt-out. Otherwise fall back to the shipped registry renderer.
//
// React escapes all interpolated text, so operator copy + merge values
// can never inject markup into the email HTML.

import "server-only";

import { render } from "@react-email/render";

import { EmailLayout, P } from "@/lib/email/templates/_layout";

import type { MessageBookingContext } from "./context";
import { ensureOptOut, interpolateMergeTags } from "./merge-tags";
import {
  renderForChannel,
  type MessageChannel,
  type MessageTemplate,
  type RenderResult,
} from "./registry";

export type TemplateOverride = {
  subjectOverride: string | null;
  bodyOverride: string | null;
  enabled: boolean;
};

export async function renderMessage(
  template: MessageTemplate,
  channel: MessageChannel,
  ctx: MessageBookingContext,
  override?: TemplateOverride | null,
): Promise<RenderResult> {
  if (override && override.enabled && override.bodyOverride && override.bodyOverride.trim()) {
    return renderOverride(channel, ctx, override);
  }
  return renderForChannel(template, channel, ctx);
}

async function renderOverride(
  channel: MessageChannel,
  ctx: MessageBookingContext,
  override: TemplateOverride,
): Promise<RenderResult> {
  const body = interpolateMergeTags(override.bodyOverride ?? "", ctx);

  if (channel === "sms") {
    return { kind: "sms", rendered: { body: ensureOptOut(body) } };
  }
  if (channel === "whatsapp") {
    // Freeform override — valid only inside the 24h session window (and
    // the sandbox). Approved-template sends keep the registry renderer.
    // The opt-out line is re-applied here too (Twilio honours STOP on
    // WhatsApp) so an override can't strip it.
    return { kind: "whatsapp", rendered: { body: ensureOptOut(body) } };
  }

  // Email — wrap the operator copy in the branded layout. Paragraphs
  // split on blank lines; React escapes each block.
  const subject = override.subjectOverride
    ? interpolateMergeTags(override.subjectOverride, ctx)
    : `A message from ${ctx.venueName}`;
  const paras = body.split(/\n{2,}/);
  const element = (
    <EmailLayout
      preview={subject}
      unsubscribeUrl={ctx.unsubscribeUrl}
      venueName={ctx.venueName}
      branding={ctx.branding}
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
