/**
 * Client identity for IP keying.
 *
 * We rely exclusively on Express's `req.ip`, which honours `X-Forwarded-For` only for hops allowed
 * by the `trust proxy` setting (default "loopback"). Locally this lets the attack engine simulate
 * distinct client IPs through the Vite proxy, while a remote caller can't spoof its address because
 * its socket peer isn't a trusted proxy.
 *
 * This is NOT the old X-Client-Id shortcut: that header was trusted from anyone. Here the forwarded
 * header is trusted only from a configured proxy hop, which is how production apps behind a load balancer work.
 */
import { isIP } from "node:net";
import type { Request } from "express";

const IPV4_MAPPED_PREFIX = "::ffff:";

/** `::ffff:127.0.0.1` → `127.0.0.1`. Other addresses are returned unchanged. */
export function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  if (lower.startsWith(IPV4_MAPPED_PREFIX)) {
    const v4 = lower.slice(IPV4_MAPPED_PREFIX.length);
    if (isIP(v4) === 4) return v4;
  }
  return lower;
}

/**
 * The IP used as a limiter key. Falls back to the raw socket address if `req.ip` isn't a valid IP
 * (for example a junk X-Forwarded-For value from a trusted hop), and to "unknown" as a last resort.
 */
export function getClientKeyIp(req: Request): string {
  for (const candidate of [req.ip, req.socket?.remoteAddress]) {
    if (candidate) {
      const ip = normalizeIp(candidate);
      if (isIP(ip) !== 0) return ip;
    }
  }
  return "unknown";
}
