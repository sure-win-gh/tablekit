// Signed unsubscribe tokens.
//
// Per-venue unsubscribe URL = /unsubscribe?p=<payload>&s=<sig>.
// payload = base64url("<guestId>.<venueId>.<channel>")
// sig     = HMAC-SHA256(payload) via lib/security/crypto.ts#hashForLookup
//
// No DB lookup needed at sign time; verification recomputes the HMAC
// and constant-time-compares. The webhook handler in wave 6 decodes
// payload and applies the unsubscribe to the guest's array column.

import "server-only";

import { Buffer } from "node:buffer";

import { constantTimeEqual, hashForLookup } from "@/lib/security/crypto";

import type { MessageChannel } from "./registry";

export type UnsubscribePayload = {
  guestId: string;
  venueId: string;
  channel: MessageChannel;
};

function encodePayload(p: UnsubscribePayload): string {
  return Buffer.from(`${p.guestId}.${p.venueId}.${p.channel}`, "utf8").toString("base64url");
}

function decodePayload(encoded: string): UnsubscribePayload | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const [guestId, venueId, channel] = decoded.split(".");
    if (!guestId || !venueId || (channel !== "email" && channel !== "sms")) return null;
    return { guestId, venueId, channel };
  } catch {
    return null;
  }
}

export function signUnsubscribe(p: UnsubscribePayload): { p: string; s: string } {
  const encoded = encodePayload(p);
  return { p: encoded, s: hashForLookup(encoded, "raw") };
}

export function verifyUnsubscribe(
  pEncoded: string,
  sigHex: string,
): UnsubscribePayload | null {
  const expected = hashForLookup(pEncoded, "raw");
  if (!constantTimeEqual(expected, sigHex)) return null;
  return decodePayload(pEncoded);
}

export function unsubscribeUrl(appUrl: string, p: UnsubscribePayload): string {
  const { p: pe, s } = signUnsubscribe(p);
  const u = new URL("/unsubscribe", appUrl);
  u.searchParams.set("p", pe);
  u.searchParams.set("s", s);
  return u.toString();
}
