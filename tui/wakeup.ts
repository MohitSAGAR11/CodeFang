import { select, isCancel } from "@clack/prompts";
import { runCliMode } from "../modes/cli";
import { runTelegramMode } from "../modes/telegram";
import { printBanner } from "./banner.ts";
import { ask, c, GLYPH, printError } from "./theme.ts";

export async function runWakeup(version: string) {
  printBanner({ version });

  const mode = await select({
    message: ask("Which mode do you want to proceed with?"),
    options: [
      { value: "cli", label: "CLI", hint: "work here in the terminal" },
      { value: "telegram", label: "Telegram", hint: "drive it from chat" },
      { value: "exit", label: "Exit" },
    ],
  });

  if (isCancel(mode) || mode === "exit") {
    console.log(c.muted(`\n${GLYPH.fang} Goodbye.\n`));
    return;
  }

  try {
    if (mode === "cli") await runCliMode();
    else if (mode === "telegram") await runTelegramMode();
  } catch (err) {
    printError(err);
  }
}
