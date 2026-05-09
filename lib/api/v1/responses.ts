// Response shapes for the public REST API.
//
// Two shapes only:
//   - Success: NextResponse.json({ data, ...meta })
//   - Error:   NextResponse.json({ error: { code, message } }, { status })
//
// Error codes are stable strings (clients can branch on them); messages
// are operator-friendly but never carry PII or stack traces. Errors
// from internal layers are caught at the wrapper boundary and mapped
// to a generic `internal_error` so an SDK exception text can't leak
// through.

import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  bad_request: 400,
  rate_limited: 429,
  internal_error: 500,
};

export function errorResponse(code: ApiErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status: STATUS[code] });
}
