import { FixedWindowLimiter } from "./fixedWindow.js";
import { SlidingWindowLogLimiter } from "./slidingWindowLog.js";
import { TokenBucketLimiter } from "./tokenBucket.js";
import type { Algorithm, LimiterOptions, RateLimiter } from "./types.js";

export * from "./types.js";
export { FixedWindowLimiter, SlidingWindowLogLimiter, TokenBucketLimiter };

export function createLimiter(algorithm: Algorithm, options: LimiterOptions): RateLimiter {
  switch (algorithm) {
    case "fixed":
      return new FixedWindowLimiter(options);
    case "sliding":
      return new SlidingWindowLogLimiter(options);
    case "token":
      return new TokenBucketLimiter(options);
    default: {
      const unreachable: never = algorithm;
      throw new Error(`Unknown algorithm: ${String(unreachable)}`);
    }
  }
}
