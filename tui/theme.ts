import chalk from "chalk";

/**
 * Single source of truth for CodeFang's terminal look.
 * Change these hex values and the whole CLI follows.
 */
export const PALETTE = {
  /** Brand violet — banner face, spinner, prompt marker. */
  accent: "#a78bfa",
  /** Deeper violet — banner shadow, box borders, timings. */
  deep: "#5b4d9e",
  /** What the user typed / chose. */
  user: "#67e8f9",
  /** CodeFang's own prose. */
  response: "#e8dcf8",
  /** System and status chatter. */
  muted: "#8b8b9e",
} as const;

export const c = {
  accent: chalk.hex(PALETTE.accent),
  brand: chalk.hex(PALETTE.accent).bold,
  deep: chalk.hex(PALETTE.deep),
  user: chalk.hex(PALETTE.user),
  response: chalk.hex(PALETTE.response),
  muted: chalk.hex(PALETTE.muted),
  success: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
};

/**
 * `▼` is the CodeFang mark: a single-width fang that exists in every
 * monospace font. (🦷 is a molar, renders double-width, and breaks
 * column math on Windows terminals — deliberately not used.)
 */
export const GLYPH = {
  fang: "▼",
  prompt: "❯",
  tool: "▸",
  ok: "✓",
  err: "✗",
  dot: "·",
} as const;

const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");
export const visibleWidth = (s: string): number => stripAnsi(s).length;

export const termWidth = (): number =>
  Math.max(40, Math.min(process.stdout.columns || 80, 100));

/** Fang-prefixed message for @clack prompts. */
export const ask = (message: string): string =>
  `${c.accent(GLYPH.fang)} ${message}`;

/** Mode header: a bold brand line over a muted rule. */
export function printSection(title: string, subtitle?: string): void {
  const width = Math.min(termWidth(), 64);
  console.log();
  console.log(
    `${c.brand(`${GLYPH.fang} ${title}`)}${subtitle ? c.muted(`  ${GLYPH.dot} ${subtitle}`) : ""}`,
  );
  console.log(c.deep("─".repeat(width)));
  console.log();
}

/** A muted `key  value` status line. */
export function printStatus(key: string, value: string): void {
  console.log(`  ${c.muted(key.padEnd(7))}${c.response(value)}`);
}

/** Rounded box with an accent border, sized to its content. */
export function box(lines: string[]): string {
  const max = Math.max(...lines.map(visibleWidth), 0);
  const width = Math.min(max, termWidth() - 4);
  const pad = (line: string) =>
    line + " ".repeat(Math.max(0, width - visibleWidth(line)));

  const top = c.deep(`╭${"─".repeat(width + 2)}╮`);
  const bottom = c.deep(`╰${"─".repeat(width + 2)}╯`);
  const body = lines.map((l) => `${c.deep("│")} ${pad(l)} ${c.deep("│")}`);
  return [top, ...body, bottom].join("\n");
}

/** Truncate to a visible width, keeping the tail (useful for paths). */
export function truncateStart(s: string, max: number): string {
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}

/** Truncate to a visible width, keeping the head. */
export function truncateEnd(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Themed error line — used instead of letting a stack trace escape. */
export function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`\n${c.error(`${GLYPH.err} ${message}`)}\n`);
}

/** Themed success line. */
export function printDone(message: string): void {
  console.log(`\n${c.success(`${GLYPH.ok} ${message}`)}\n`);
}
