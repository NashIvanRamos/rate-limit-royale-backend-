/**
 * The default LimiterStore: one in-memory limiter per process. Correct on a single node. Behind a load balancer each
 * node has its own counters, so a client gets roughly N× the limit (measured in docs/distributed.md).
 */
import { createLimiter } from "./index.js";
import type { Algorithm, LimitDecision, LimiterOptions, LimiterStore, LimiterStoreFactory, RateLimiter } from "./types.js";

export class MemoryStore implements LimiterStore {
  constructor(readonly limiter: RateLimiter) {}

  get name(): Algorithm {
    return this.limiter.name;
  }

  allow(key: string, now: number): Promise<LimitDecision> {
    return Promise.resolve(this.limiter.allow(key, now));
  }

  size(): Promise<number> {
    return Promise.resolve(this.limiter.size());
  }
}

export const memoryStoreFactory: LimiterStoreFactory = (algorithm: Algorithm, options: LimiterOptions) =>
  new MemoryStore(createLimiter(algorithm, options));
