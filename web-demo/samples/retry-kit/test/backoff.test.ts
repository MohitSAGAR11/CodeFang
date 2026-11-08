import { describe, expect, test } from "bun:test";
import { computeDelay } from "../src/backoff";

const opts = { baseDelayMs: 100, maxDelayMs: 1_000, jitter: false };

describe("computeDelay", () => {
  test("doubles each attempt", () => {
    expect(computeDelay(0, opts)).toBe(100);
    expect(computeDelay(1, opts)).toBe(200);
    expect(computeDelay(2, opts)).toBe(400);
  });

  test("caps at maxDelayMs without jitter", () => {
    expect(computeDelay(10, opts)).toBe(1_000);
  });

  test("jitter stays positive", () => {
    const d = computeDelay(3, { ...opts, jitter: true }, () => 0.5);
    expect(d).toBeGreaterThan(0);
  });
});
