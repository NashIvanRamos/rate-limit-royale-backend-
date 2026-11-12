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
} as const;
