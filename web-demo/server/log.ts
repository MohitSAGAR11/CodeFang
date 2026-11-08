/**
 * One JSON line per event on stdout. Callers pass only counters and enums:
 * never prompts, file contents, IPs or keys.
 */
export function log(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
  if (process.env.DEMO_QUIET === "1") return;
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
