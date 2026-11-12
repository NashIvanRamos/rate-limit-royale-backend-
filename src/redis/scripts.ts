/**
 * Lua scripts (tasks2). Each runs atomically inside Redis. `keys` is the number of leading arguments that are keys.
 * Time (`now`, ms) is passed in from the app so tests can use a fake clock; see tasks2/04 for the trade-off vs. TIME.
 */

export const SCRIPTS = {
  /**
   * Read the deployed defense, initialising it with the default on first use.
   * KEYS: defense hash, generation counter. ARGV: default config JSON, now.
   * Returns [configJson, deployedAt, generation].
   */
  rlrDefenseGet: {
    keys: 2,
    lua: `
local v = redis.call('HMGET', KEYS[1], 'config', 'deployedAt', 'gen')
if v[1] then return v end
local gen = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'config', ARGV[1], 'deployedAt', ARGV[2], 'gen', gen)
return {ARGV[1], ARGV[2], tostring(gen)}
`,
  },

  /**
   * Deploy a defense: bump the generation and store the config in one step.
   * KEYS: defense hash, generation counter. ARGV: config JSON, now. Returns the new generation.
   */
  rlrDefenseDeploy: {
    keys: 2,
    lua: `
local gen = redis.call('INCR', KEYS[2])
redis.call('HSET', KEYS[1], 'config', ARGV[1], 'deployedAt', ARGV[2], 'gen', gen)
return gen
`,
  },

  // ─── Limiters (tasks2/04) ────────────────────────────────────────────────
  // Every script returns {allowed (0|1), retryAfterMs, remaining}, the same LimitDecision as the in-memory classes,
  // and follows the same rule: a denied request never consumes budget. Each also adds the key to a per-generation
  // set (KEYS[2]) so /api/stats can report how many keys the round is tracking.
  // Numbers are written with %.17g: Redis's default number→string conversion keeps only 14 significant digits.
  // TTLs are only for cleanup, so they get a 60s margin: a key must never expire before its window does.

  /**
   * Fixed window. KEYS: counter (one per window index), keyset.
   * ARGV: max, windowEnd, now, keysetTtlMs, key.
   */
  rlrFixed: {
    keys: 2,
    lua: `
local max, windowEnd, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('SADD', KEYS[2], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= max then return {0, windowEnd - now, 0} end
count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], math.max(1, windowEnd - now) + 60000) end
return {1, 0, max - count}
`,
  },

  /**
   * Sliding window log. KEYS: sorted set of accepted timestamps, keyset, sequence counter (unique members).
   * ARGV: max, windowMs, now, keysetTtlMs, key, peek ("1" = decide without recording; the login guard's check).
   */
  rlrSliding: {
    keys: 3,
    lua: `
local max, window, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%.17g', now - window))
local n = redis.call('ZCARD', KEYS[1])
if n >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + window - now, 0}
end
if ARGV[6] == '1' then return {1, 0, max - n} end
redis.call('SADD', KEYS[2], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
local seq = redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], ARGV[4])
-- Two requests in the same millisecond need distinct members, or the second would overwrite the first.
redis.call('ZADD', KEYS[1], string.format('%.17g', now), string.format('%.17g', now) .. '-' .. seq)
redis.call('PEXPIRE', KEYS[1], window + 60000)
return {1, 0, max - n - 1}
`,
  },

  /**
   * Token bucket. KEYS: hash {tokens, last}, keyset.
   * ARGV: capacity, refillPerMs, now, keysetTtlMs, key, bucketTtlMs (time to refill fully + margin: a full bucket is the same as no key).
   */
  rlrToken: {
    keys: 2,
    lua: `
local cap, rate, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local EPS = 1e-9
local b = redis.call('HMGET', KEYS[1], 'tokens', 'last')
local tokens, last
if not b[1] then
  tokens, last = cap, now
else
  tokens, last = tonumber(b[1]), tonumber(b[2])
  tokens = math.min(cap, tokens + math.max(0, now - last) * rate)
  last = math.max(last, now)
end
redis.call('SADD', KEYS[2], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
local allowed = tokens >= 1 - EPS
if allowed then tokens = math.max(0, tokens - 1) end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', tokens), 'last', string.format('%.17g', last))
redis.call('PEXPIRE', KEYS[1], ARGV[6])
if allowed then return {1, 0, math.floor(tokens + EPS)} end
return {0, math.max(1, math.ceil((1 - tokens) / rate)), 0}
`,
  },
} as const;
