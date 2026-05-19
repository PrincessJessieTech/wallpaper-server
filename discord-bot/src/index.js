import { registerCommands, client } from "./bot.js";
import { config } from "dotenv";

config(); // Load .env

// Validate required env vars
const required = ["DISCORD_TOKEN", "CLIENT_ID", "REPO_PATH", "GITHUB_RAW_BASE"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[error] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Register slash commands then start the bot
registerCommands()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error("[error] Startup failed:", err);
    process.exit(1);
  });
