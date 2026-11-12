/**
 * Round state in Redis (tasks2/03): a deploy on any node applies to every node, and all nodes agree on the window
 * epoch and the generation.
 *
 *   <prefix>defense      hash { config (JSON), deployedAt, gen }
 *   <prefix>defense:gen  counter, bumped by every deploy
 *
 * Every request reads the hash (one round-trip, ~0.1 ms locally). Caching it with pub/sub invalidation would be
 * faster, but then nodes could briefly disagree after a deploy. Correct and simple first.
 */
import type { Algorithm, LimiterOptions, LimiterStore } from "../algorithms/index.js";
import { DEFAULT_DEFENSE, type DefenseConfig, type DefenseSnapshot } from "../config/defense.js";
import { keyspace, type AppRedis } from "../redis/client.js";
import { snapshotOf, type RoundState, type RoundView } from "./round.js";

/** Builds the limiter store for one generation. Redis stores namespace their keys by it (tasks2/04). */
export type GenerationStoreFactory = (algorithm: Algorithm, options: LimiterOptions, generation: number) => LimiterStore;

export class RedisRoundState implements RoundState {
  readonly backend = "redis" as const;
  private readonly key: ReturnType<typeof keyspace>;
  /** The store for the latest generation seen, reused across requests. */
  private cached: { generation: number; store: LimiterStore } | null = null;

  constructor(
    private readonly redis: AppRedis,
    prefix: string,
    private readonly now: () => number,
    private readonly storeFactory: GenerationStoreFactory,
  ) {
    this.key = keyspace(prefix);
  }

  async current(): Promise<RoundView> {
    const [configJson, deployedAt, gen] = (await this.redis.rlrDefenseGet(
      this.key("defense"),
      this.key("defense", "gen"),
      JSON.stringify(DEFAULT_DEFENSE),
      this.now(),
    )) as [string, string, string];
    return this.view(JSON.parse(configJson) as DefenseConfig, Number(deployedAt), Number(gen));
  }

  async deploy(config: DefenseConfig, now: number): Promise<DefenseSnapshot> {
    const gen = Number(await this.redis.rlrDefenseDeploy(this.key("defense"), this.key("defense", "gen"), JSON.stringify(config), now));
    return snapshotOf(this.view(config, now, gen));
  }

  private view(config: DefenseConfig, deployedAt: number, generation: number): RoundView {
    if (this.cached?.generation !== generation) {
      const options = { maxRequests: config.maxRequests, windowMs: config.windowMs, epochMs: deployedAt };
      this.cached = { generation, store: this.storeFactory(config.algorithm, options, generation) };
    }
    return { config, deployedAt, generation, store: this.cached.store };
  }
}
