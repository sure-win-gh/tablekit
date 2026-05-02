// Composition layer over the LLM wrapper. Keeps the runner
// dependency-free of the SDK so PR3's writer can mock at this
// boundary.
//
// Currently a thin re-export — the LLM wrapper already validates
// against ParsedEnquirySchema via structured outputs. As the
// pipeline grows (post-parse normalisation: date-relative resolution,
// honorific stripping fallbacks, etc.) those transforms land here,
// not in lib/llm/.

import "server-only";

import { parseEnquiry as callLlm, type ParseResult } from "@/lib/llm/bedrock";

export type { ParseResult } from "@/lib/llm/bedrock";

export async function parseEnquiry(rawBody: string): Promise<ParseResult> {
  return callLlm(rawBody);
}
