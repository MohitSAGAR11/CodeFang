export interface RateDecision {
  ok: boolean;
  remaining: number;
  /** Milliseconds until the next slot frees up (0 when ok). */
  retryAfterMs: number;
}

type Clock = () => number;

/**
 * Sliding-window limiter: at most `limit` hits per `windowMs` per key.
 * Memory is bounded by `maxKeys`; the stalest key is evicted first.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: Clock = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Record a hit if allowed. */
  take(key: string): RateDecision {
    const decision = this.peek(key);
    if (!decision.ok) return decision;
    const list = this.hits.get(key) ?? [];
    // Re-insert so Map order tracks recency for eviction.
    this.hits.delete(key);
    this.hits.set(key, [...list, this.now()]);
    this.evict();
    return { ...decision, remaining: decision.remaining - 1 };
  }

  /** Check without recording. */
  peek(key: string): RateDecision {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (fresh.length) this.hits.set(key, fresh);
    else this.hits.delete(key);

    if (fresh.length >= this.limit) {
      const oldest = fresh[0] ?? t;
      return { ok: false, remaining: 0, retryAfterMs: Math.max(0, oldest + this.windowMs - t) };
    }
    return { ok: true, remaining: this.limit - fresh.length, retryAfterMs: 0 };
  }

  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }
}

/** A global per-UTC-day counter for runs billed to the server key. */
export class DailyBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly now: Clock = Date.now,
  ) {}

  private roll(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  take(): boolean {
    this.roll();
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  /** Give a slot back (e.g. the run was rejected before reaching the model). */
  refund(): void {
    this.roll();
    this.used = Math.max(0, this.used - 1);
  }

  get remaining(): number {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }
}

/**
 * The bucket an IP is limited under. IPv6 clients usually control a whole
 * /64, so they share one bucket; IPv4 (and IPv4-mapped IPv6) is per address.
 */
export function limiterKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
