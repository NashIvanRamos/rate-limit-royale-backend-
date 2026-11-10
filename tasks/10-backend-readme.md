# 10: Backend README and interview notes

## Goal
A `README.md` at the repo root that explains every trade-off in doc §11, so the code and the
interview story match (doc §10 Day 4, §12 "READMEs explain every trade-off").

## Sections
1. **Run it:** `.env` setup, `npm run dev`, `npm test`, `npm run smoke`, `npm run replay`.
2. **API reference:** the four endpoints plus `/api/stats`, `/api/demo/expired-token`. Request and response
   examples, status codes, all 401 reasons, 429 + `Retry-After`.
3. **Middleware order:** auth → key → limiter → handler, with a diagram and the "forged tokens can't
   drain budgets" proof (link to the test from task 06).
4. **Limiter trade-offs:** a table of the three algorithms (memory, accuracy, burst behaviour, boundary
   issue, which to pick for a public API and why). Include measured smoke output.
5. **Keying strategy:** why login is keyed by IP, why authenticated requests use `sub`, how keying by user
   is gamed by account rotation (round 5), shared NAT/proxy problems with IP keying, `trust proxy`,
   and that most systems combine both.
6. **JWT:** pinned `HS256` and what `alg: none` would allow otherwise, payload readable by anyone,
   15-minute expiry, and no revocation without a denylist (short access tokens + refresh tokens is the usual trade-off).
7. **Login limiting:** failed-attempt counting per IP and why (rounds 4 and 5).
8. **Honest limits:** in-memory state (single instance only, Redis for multi-instance), simulated IPs via
   loopback-trusted `X-Forwarded-For`, unauthenticated `/api/defense`, plaintext demo passwords,
   no stale-key sweeping, legitimacy labels live client-side, and why `X-Client-Id` was removed.

## Acceptance criteria
- Every bullet in doc §11 maps to a README section.
- Every number quoted in the README came from a real `smoke`/`replay` run.
