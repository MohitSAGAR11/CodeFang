export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Delay before retry number `attempt` (0 = the wait after the first failure).
 *
 * Exponential: base * 2^attempt, capped at maxDelayMs, then jittered.
 */
export function computeDelay(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponential = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, opts.maxDelayMs);

  if (!opts.jitter) return capped;

  // "Full jitter" spreads retries out so clients don't stampede together.
  // We add up to 50% on top so the average wait stays close to `capped`.
  const spread = capped * 0.5;
  return Math.round(capped + random() * spread);
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
