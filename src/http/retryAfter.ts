import type { Response } from "express";

/** Sets `Retry-After` in whole seconds (RFC 9110), rounded up, minimum 1. */
export function setRetryAfter(res: Response, retryAfterMs: number): void {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
}
