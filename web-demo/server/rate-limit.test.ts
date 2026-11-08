import { describe, expect, test } from "bun:test";
import { DailyBudget, RateLimiter } from "./rate-limit.ts";

describe("RateLimiter", () => {
  test("allows up to the limit, then blocks with a retry hint", () => {
    let t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    expect(rl.take("ip").ok).toBe(true);
    expect(rl.take("ip").ok).toBe(true);
    const third = rl.take("ip");
    expect(third.ok).toBe(true);
    expect(third.remaining).toBe(0);
    t = 400;
    const blocked = rl.take("ip");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBe(600);
  });

  test("slots free up as the window slides", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    rl.take("ip");
    t = 500;
    rl.take("ip");
    t = 999;
    expect(rl.take("ip").ok).toBe(false);
    t = 1000;
    expect(rl.take("ip").ok).toBe(true); // the t=0 hit expired
    expect(rl.take("ip").ok).toBe(false);
  });

  test("keys are independent", () => {
    const rl = new RateLimiter(1, 1000, () => 0);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    expect(rl.take("b").ok).toBe(true);
  });

  test("blocked attempts do not extend the ban", () => {
    let t = 0;
    const rl = new RateLimiter(1, 1000, () => t);
    rl.take("ip");
    for (t = 100; t < 1000; t += 100) rl.take("ip");
    t = 1000;
    expect(rl.take("ip").ok).toBe(true);
  });

  test("memory is bounded by maxKeys", () => {
    const rl = new RateLimiter(1, 1000, () => 0, 2);
    rl.take("a");
    rl.take("b");
    rl.take("c"); // evicts "a"
    expect(rl.take("a").ok).toBe(true);
  });
});

describe("DailyBudget", () => {
  test("caps total runs per UTC day and resets at midnight", () => {
    let t = Date.parse("2026-11-08T23:59:00Z");
    const b = new DailyBudget(2, () => t);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t = Date.parse("2026-11-09T00:00:01Z");
    expect(b.remaining).toBe(2);
    expect(b.take()).toBe(true);
  });
});

describe("limiterKey", () => {
  test("IPv4 stays per address; IPv4-mapped IPv6 is unwrapped", async () => {
    const { limiterKey } = await import("./rate-limit.ts");
    expect(limiterKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limiterKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  test("IPv6 addresses in one /64 share a bucket", async () => {
    const { limiterKey } = await import("./rate-limit.ts");
    const a = limiterKey("2001:db8:abcd:12:1111:2222:3333:4444");
    const b = limiterKey("2001:db8:abcd:12::9");
    const c = limiterKey("2001:db8:abcd:13::9");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
