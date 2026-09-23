import figlet from "figlet";
import {
  box,
  c,
  GLYPH,
  termWidth,
  truncateStart,
  truncateEnd,
} from "./theme.ts";

const BANNER_FONT = "ANSI Shadow";
const TAGLINE = "agentic coding in your terminal";

function renderAscii(): string {
  try {
    return figlet.textSync("CodeFang", { font: BANNER_FONT });
  } catch {
    return figlet.textSync("CodeFang", { font: "Standard" });
  }
}

/**
 * Draw the wordmark twice — once in the deep violet, then again one line
 * up in the light face — so the letters carry a drop shadow.
 */
function printWordmark(ascii: string): void {
  const lines = ascii.replace(/\s+$/, "").split("\n");
  const rowWidth = Math.max(...lines.map((l) => l.length), 0) + 2;

  for (const line of lines) console.log(c.deep(("  " + line).padEnd(rowWidth)));
  process.stdout.write(`\x1b[${lines.length}A`);
  for (const line of lines) console.log(c.response(line.padEnd(rowWidth)));
}

/** One-line brand, used in `--help` and on narrow terminals. */
export function compactBrand(version?: string): string {
  const v = version ? c.deep(` v${version}`) : "";
  return `${c.brand(`${GLYPH.fang} CodeFang`)}${v}  ${c.muted(`${GLYPH.dot} ${TAGLINE}`)}`;
}

export function printBanner(opts: { version: string }): void {
  const width = termWidth();
  const ascii = renderAscii();
  const fits = Math.max(...ascii.split("\n").map((l) => l.length)) + 2 <= width;

  console.log();
  if (fits) {
    printWordmark(ascii);
    console.log(
      `  ${c.accent(GLYPH.fang)} ${c.muted(TAGLINE)} ${c.deep(`v${opts.version}`)}`,
    );
  } else {
    console.log("  " + compactBrand(opts.version));
  }
  console.log();
  console.log(printHeaderBox());
  console.log();
}

function printHeaderBox(): string {
  const budget = Math.max(24, termWidth() - 12);
  const model = process.env.OPENROUTER_DEFAULT_MODEL?.trim();

  const rows: Array<[string, string]> = [
    ["cwd", truncateStart(process.cwd(), budget)],
  ];
  if (model) rows.push(["model", truncateEnd(model, budget)]);

  return box(
    rows.map(([k, v]) => `${c.muted(k.padEnd(6))}${c.response(v)}`),
  );
}
