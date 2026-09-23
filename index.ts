#!/usr/bin/env bun
import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { compactBrand } from "./tui/banner";
import { GLYPH } from "./tui/theme";

const VERSION = "0.0.1";

const program = new Command();

program
  .name("codefang")
  .description(`${GLYPH.fang} CodeFang — agentic coding in your terminal`)
  .version(VERSION, "-v, --version")
  .addHelpText("beforeAll", `\n${compactBrand(VERSION)}\n`)
  .action(async () => {
    await runWakeup(VERSION);
  });

program
  .command("wakeup")
  .description("Show the banner and pick CLI or Telegram mode")
  .action(async () => {
    await runWakeup(VERSION);
  });

await program.parseAsync(process.argv);
