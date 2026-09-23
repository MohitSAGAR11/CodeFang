import { c, GLYPH } from "./theme.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

const CLEAR_LINE = "\r\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

let restoreHooked = false;
function hookCursorRestore(): void {
  if (restoreHooked) return;
  restoreHooked = true;
  const restore = () => process.stdout.write(SHOW_CURSOR);
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
}

/**
 * Braille spinner with a swappable status label and elapsed timer.
 *
 * Every write goes through `CLEAR_LINE` first, so the animation never
 * leaves fragments behind when real output arrives — call `log()` to print
 * above a running spinner, or `stop()` before handing the terminal to a
 * prompt.
 *
 * Off a TTY (CI, piped output) there is no animation: each new status label
 * is printed once as a plain line. `isActive` tracks the spinner's logical
 * state, so it reads the same in both modes.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private startedAt = 0;
  private label = "";
  private active = false;
  private painted = false;
  private announced = "";
  private readonly tty = Boolean(process.stdout.isTTY);

  get isActive(): boolean {
    return this.active;
  }

  start(label: string): void {
    if (this.active) return this.update(label);

    this.active = true;
    this.label = label;
    this.frame = 0;
    this.startedAt = Date.now();

    if (!this.tty) return this.announce(label);

    hookCursorRestore();
    process.stdout.write(HIDE_CURSOR);
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, INTERVAL_MS);
    // Never keep the process alive on the animation alone.
    this.timer.unref?.();
  }

  /** Swap the status label; starts the spinner if it is not running. */
  update(label: string): void {
    if (!this.active) return this.start(label);
    if (this.label === label) return;

    this.label = label;
    if (this.tty) this.render();
    else this.announce(label);
  }

  /** Print a line above the spinner without disturbing the animation. */
  log(line: string): void {
    if (!this.tty || !this.timer) {
      console.log(line);
      return;
    }
    process.stdout.write(CLEAR_LINE + line + "\n");
    this.render();
  }

  /** Clear the spinner line. Optionally leave a final line in its place. */
  stop(final?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty && this.painted) {
      process.stdout.write(CLEAR_LINE + SHOW_CURSOR);
      this.painted = false;
    }
    this.active = false;
    this.announced = "";
    if (final) console.log(final);
  }

  /** Stop and report how long the work took. */
  done(message: string): void {
    this.stop(`${c.success(GLYPH.ok)} ${c.muted(message)} ${this.elapsedTag()}`);
  }

  private announce(label: string): void {
    if (this.announced === label) return;
    this.announced = label;
    console.log(c.muted(`${GLYPH.fang} ${label}`));
  }

  private elapsedTag(): string {
    const secs = (Date.now() - this.startedAt) / 1000;
    return c.deep(secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`);
  }

  private render(): void {
    const frame = c.accent(FRAMES[this.frame] ?? FRAMES[0]!);
    this.painted = true;
    process.stdout.write(
      `${CLEAR_LINE}${frame} ${c.muted(this.label)} ${this.elapsedTag()}`,
    );
  }
}
