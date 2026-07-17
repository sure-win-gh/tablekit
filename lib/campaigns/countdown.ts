// Self-hosted countdown image (marketing-suite Phase C).
//
// The countdown block renders as <img src="/api/countdown/<token>">. The
// token is HMAC-signed (same primitive as unsubscribe tokens) and carries
// ONLY the target instant + optionally the campaign id — no guest
// identifiers, so the image URL is not a tracking surface. The endpoint
// draws the time remaining AT REQUEST TIME as a single-frame GIF
// (Cache-Control: private, max-age=60), so every open shows a current
// value. Competitors charge ~$10+/mo for this via third-party services;
// ours is ~200 lines and stays inside UK infrastructure.
//
// The GIF is produced by a dependency-free GIF89a encoder using the
// classic "uncompressed LZW" trick (emit a CLEAR code before the code
// table ever grows past 9 bits) and a 5×7 bitmap font. Known caveats
// (documented in the operator UI): Apple Mail privacy proxy may prefetch
// a snapshot, and the value freezes once the client caches the image.

import "server-only";

import { Buffer } from "node:buffer";

import { constantTimeEqual, hashForLookup } from "@/lib/security/crypto";

// --- Token -----------------------------------------------------------------

export type CountdownPayload = { targetMs: number; campaignId?: string | undefined };

function encodePayload(p: CountdownPayload): string {
  const raw = p.campaignId ? `${p.targetMs}:${p.campaignId}` : String(p.targetMs);
  return Buffer.from(raw, "utf8").toString("base64url");
}

export function signCountdown(p: CountdownPayload): string {
  const encoded = encodePayload(p);
  return `${encoded}.${hashForLookup(encoded, "raw")}`;
}

export function verifyCountdown(token: string): CountdownPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!constantTimeEqual(hashForLookup(encoded, "raw"), sig)) return null;
  try {
    const raw = Buffer.from(encoded, "base64url").toString("utf8");
    const [ms, campaignId] = raw.split(":");
    const targetMs = Number(ms);
    if (!Number.isFinite(targetMs)) return null;
    return { targetMs, ...(campaignId ? { campaignId } : {}) };
  } catch {
    return null;
  }
}

export function countdownImageUrl(appUrl: string, p: CountdownPayload): string {
  return new URL(`/api/countdown/${signCountdown(p)}`, appUrl).toString();
}

// --- Remaining-time text -----------------------------------------------------

export function countdownText(targetMs: number, nowMs: number): string {
  const remaining = Math.floor((targetMs - nowMs) / 1000);
  if (remaining <= 0) return "IT'S ON!";
  const d = Math.floor(remaining / 86_400);
  const h = Math.floor((remaining % 86_400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  if (d > 0) return `${d}D ${h}H ${m}M`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// --- 5×7 bitmap font (rows top→bottom, 5-bit patterns) -----------------------

const FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  "!": [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00000, 0b00100],
  "'": [0b00100, 0b00100, 0b01000, 0b00000, 0b00000, 0b00000, 0b00000],
  ":": [0b00000, 0b00100, 0b00000, 0b00000, 0b00100, 0b00000, 0b00000],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

// --- GIF89a encoder (single frame, 8-bit palette, uncompressed LZW) ----------

const SCALE = 6; // each font pixel → 6×6 device pixels
const PAD = 14;
const CHAR_W = 6; // 5px glyph + 1px spacing

class BitWriter {
  bytes: number[] = [];
  private cur = 0;
  private nbits = 0;
  push(code: number, width: number): void {
    this.cur |= code << this.nbits;
    this.nbits += width;
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>= 8;
      this.nbits -= 8;
    }
  }
  end(): void {
    if (this.nbits > 0) this.bytes.push(this.cur & 0xff);
  }
}

export function renderCountdownGif(targetMs: number, nowMs: number): Buffer {
  const text = countdownText(targetMs, nowMs);
  const chars = [...text].map((c) => FONT[c] ?? FONT[" "]!);

  const width = chars.length * CHAR_W * SCALE - SCALE + PAD * 2;
  const height = 7 * SCALE + PAD * 2;

  // Palette-indexed canvas: 0 = white, 1 = ink.
  const px = new Uint8Array(width * height); // zero-filled = white
  chars.forEach((glyph, ci) => {
    const x0 = PAD + ci * CHAR_W * SCALE;
    glyph.forEach((rowBits, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (!(rowBits & (1 << (4 - rx)))) continue;
        for (let sy = 0; sy < SCALE; sy++) {
          const y = PAD + ry * SCALE + sy;
          const rowOff = y * width + x0 + rx * SCALE;
          px.fill(1, rowOff, rowOff + SCALE);
        }
      }
    });
  });

  // --- assemble the GIF ---
  const out: number[] = [];
  const u16 = (n: number) => out.push(n & 0xff, (n >> 8) & 0xff);

  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  u16(width);
  u16(height);
  out.push(0xf7, 0x00, 0x00); // GCT present, 256 entries; bg 0; no aspect
  // Global colour table: white, ink, then black padding to 256 entries.
  out.push(255, 255, 255, 17, 17, 17);
  for (let i = 2; i < 256; i++) out.push(0, 0, 0);

  out.push(0x2c); // image descriptor
  u16(0);
  u16(0);
  u16(width);
  u16(height);
  out.push(0x00); // no local colour table

  // LZW data, "uncompressed": with an 8-bit min code size, codes are 9
  // bits and the decoder's table grows by one entry per code — emitting a
  // CLEAR every 250 literals keeps it below 512 so the code width never
  // leaves 9 bits and no compression state is needed.
  const CLEAR = 256;
  const EOI = 257;
  out.push(8); // LZW minimum code size
  const bw = new BitWriter();
  bw.push(CLEAR, 9);
  let sinceClear = 0;
  for (const p of px) {
    bw.push(p, 9);
    if (++sinceClear === 250) {
      bw.push(CLEAR, 9);
      sinceClear = 0;
    }
  }
  bw.push(EOI, 9);
  bw.end();
  for (let i = 0; i < bw.bytes.length; i += 255) {
    const chunk = bw.bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0x00); // block terminator
  out.push(0x3b); // trailer

  return Buffer.from(out);
}
