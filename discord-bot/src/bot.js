import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, AttachmentBuilder } from "discord.js";
import { createWriteStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { join } from "path";
import { Readable } from "stream";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;       // Bot's application ID
const GUILD_ID        = process.env.GUILD_ID;        // Optional: restrict command to one server (faster deploy)
const REPO_PATH       = process.env.REPO_PATH;       // Absolute path to local git repo clone
const GITHUB_RAW_BASE = process.env.GITHUB_RAW_BASE; // e.g. https://raw.githubusercontent.com/user/repo/refs/heads/main
const GIT_USER_NAME   = process.env.GIT_USER_NAME  || "wallpaper-bot";
const GIT_USER_EMAIL  = process.env.GIT_USER_EMAIL || "bot@example.com";
const IMAGE_SUBDIR    = process.env.IMAGE_SUBDIR   || "images"; // Subdirectory inside repo for images
const JSON_FILE       = process.env.JSON_FILE      || "wallpaper.json"; // Relative to repo root
const AMEND_COMMITS   = process.env.AMEND_COMMITS  === "true"; // If true, amend+force-push to avoid binary blob history
const GIT_BRANCH      = process.env.GIT_BRANCH;    // e.g. main — branch to pull/push for wallpaper updates

const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
const MIME_TO_EXT  = {
  "image/png":  ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif":  ".gif",
  "image/avif": ".avif",
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function git(...args) {
  const cmd = `git -C "${REPO_PATH}" ${args.join(" ")}`;
  console.log(`[git] ${cmd}`);
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function syncGitBranch() {
  if (!GIT_BRANCH) {
    git("pull", "--rebase", "--autostash");
    return;
  }
  git("fetch", "origin");
  git("checkout", GIT_BRANCH);
  git("pull", "--rebase", "origin", GIT_BRANCH, "--autostash");
}

function pushGitBranch(force = false) {
  const args = ["push"];
  if (force) args.push("--force");
  if (GIT_BRANCH) args.push("origin", GIT_BRANCH);
  git(...args);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

function resolveExtension(attachment) {
  if (attachment.contentType) {
    const mime = attachment.contentType.split(";")[0].trim().toLowerCase();
    if (MIME_TO_EXT[mime]) return MIME_TO_EXT[mime];
  }
  const match = (attachment.name || "").match(/\.[a-z0-9]+$/i);
  return match ? match[0].toLowerCase() : ".png";
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, "utf8")); }
  catch { return null; }
}

function previousImageFilename(existing) {
  if (!existing) return null;
  if (existing.filename) return existing.filename;
  if (!existing.imageUrl) return null;
  const pathname = existing.imageUrl.split("?")[0];
  const name = pathname.split("/").pop();
  return name || null;
}

// ─── COMMAND REGISTRATION ──────────────────────────────────────────────────────

export async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName("wallpaper")
    .setDescription("Update the server wallpaper with an image")
    .addAttachmentOption(opt =>
      opt.setName("image")
        .setDescription("The wallpaper image (PNG, JPG, WEBP, AVIF)")
        .setRequired(true)
    );

  const rest = new REST().setToken(DISCORD_TOKEN);
  const body = [command.toJSON()];

  if (GUILD_ID) {
    // Guild command: registers instantly (good for development)
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`[bot] Slash command registered for guild ${GUILD_ID}`);
  } else {
    // Global command: can take up to 1 hour to propagate
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log("[bot] Slash command registered globally");
  }
}

// ─── COMMAND HANDLER ───────────────────────────────────────────────────────────

async function handleWallpaperCommand(interaction) {
  const attachment = interaction.options.getAttachment("image");
  const mime = (attachment.contentType || "").split(";")[0].trim().toLowerCase();

  // Validate MIME type
  if (!ALLOWED_MIME.includes(mime)) {
    return interaction.reply({
      content: `❌ File type \`${mime || "unknown"}\` is not supported. Please use PNG, JPG, WEBP, GIF, or AVIF.`,
      ephemeral: true,
    });
  }

  // Acknowledge interaction early (Discord requires a response within 3 seconds)
  await interaction.deferReply();

  try {
    const ext       = resolveExtension(attachment);
    const filename  = `wallpaper-${interaction.id}${ext}`;
    const imageDir  = join(REPO_PATH, IMAGE_SUBDIR);
    const localPath = join(imageDir, filename);
    const repoRelPath = `${IMAGE_SUBDIR}/${filename}`;

    // Ensure image subdirectory exists
    mkdirSync(imageDir, { recursive: true });

    // 1. Pull latest to avoid conflicts (GIT_BRANCH checks out that branch first)
    syncGitBranch();

    // 2. Download image
    console.log(`[bot] Downloading ${attachment.url} → ${localPath}`);
    await downloadFile(attachment.url, localPath);

    // 3. Compute SHA-256
    const hash = sha256File(localPath);
    console.log(`[bot] SHA-256: ${hash}`);

    // 4. Deduplicate — skip if same hash already committed
    const jsonFilePath = join(REPO_PATH, JSON_FILE);
    const existing = readJson(jsonFilePath);

    if (existing?.hash === hash) {
      execSync(`rm -f "${localPath}"`);
      return interaction.editReply({
        content: `ℹ️ This image is identical to the current wallpaper (same hash). No changes committed.`,
      });
    }

    // 5. Build the permanent raw GitHub URL
    const imageUrl = `${GITHUB_RAW_BASE.replace(/\/$/, "")}/${repoRelPath}`;

    // 6. Write wallpaper.json
    const payload = { hash, imageUrl };
    writeFileSync(jsonFilePath, JSON.stringify(payload, null, 2) + "\n", "utf8");

    // 7. Remove previous image file to keep working tree clean
    const previousFilename = previousImageFilename(existing);
    if (previousFilename && previousFilename !== filename) {
      const oldPath = join(REPO_PATH, IMAGE_SUBDIR, previousFilename);
      if (existsSync(oldPath)) {
        execSync(`rm -f "${oldPath}"`);
        git("rm", "--cached", "--ignore-unmatch", `"${IMAGE_SUBDIR}/${previousFilename}"`);
      }
    }

    // 8. Stage changes
    git("config", `user.name "${GIT_USER_NAME}"`);
    git("config", `user.email "${GIT_USER_EMAIL}"`);
    git("add", `"${repoRelPath}"`, `"${JSON_FILE}"`);

    // 9. Commit strategy
    const commitMsg = `wallpaper: update to ${filename} [${hash.slice(0, 8)}]`;
    if (AMEND_COMMITS) {
      // Amend the last commit to avoid accumulating binary blob history
      git("commit", `--amend`, `-m "${commitMsg}"`, `--reset-author`);
      pushGitBranch(true);
    } else {
      git("commit", `-m "${commitMsg}"`);
      pushGitBranch(false);
    }

    // 10. Public success reply — image only (no status text)
    await interaction.editReply({
      files: [new AttachmentBuilder(localPath, { name: filename })],
    });

    console.log(`[bot] Done. Committed ${filename} (${hash})`);

  } catch (err) {
    console.error("[bot] Error:", err);
    await interaction.editReply({
      content: `❌ Something went wrong: \`${err.message}\``,
    });
  }
}

// ─── BOT SETUP ─────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Note: no MessageContent intent needed — slash commands don't require it
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "wallpaper") {
    await handleWallpaperCommand(interaction);
  }
});

export { client };
