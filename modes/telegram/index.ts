import { Telegraf } from "telegraf";
import { WELCOME } from "./constants";
import { registerHandlers } from "./handlers";
import { c, GLYPH, printError, printSection } from "../../tui/theme.ts";

export async function runTelegramMode() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerId = process.env.TELEGRAM_OWNER_ID;

  if (!token || !ownerId) {
    printError(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must both be set in .env",
    );
    return;
  }

  printSection("Telegram", "drive CodeFang from chat");

  const bot = new Telegraf(token);
  registerHandlers(bot);

  await bot.telegram.sendMessage(ownerId, WELCOME, { parse_mode: "Markdown" });
  console.log(`  ${c.success(GLYPH.ok)} ${c.muted("welcome message sent")}`);

  bot.launch();
  console.log(
    `  ${c.accent(GLYPH.fang)} ${c.response("Bot is running.")} ${c.muted("Press Ctrl+C to stop.")}\n`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      bot.stop("SIGINT");
      console.log(c.muted(`\n${GLYPH.fang} Bot stopped.\n`));
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
