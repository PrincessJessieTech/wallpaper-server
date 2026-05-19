# discord-wallpaper-bot

A Discord bot that exposes a `/wallpaper` slash command. When a user runs the command with an image attachment, the bot:

1. Validates the attachment is a supported image type (PNG, JPG, WEBP, GIF, AVIF)
2. Downloads the image locally
3. Computes a **SHA-256** hash
4. Skips if the hash matches the already-committed wallpaper (deduplication)
5. Removes the previous wallpaper file from the repo
6. Updates `wallpaper.json` with the hash and a permanent raw GitHub URL
7. Commits and pushes (with optional amend+force-push to prevent history bloat)
8. Replies in the channel with the new wallpaper image only (no status text)

## JSON output format

```json
{
  "hash": "abcdef1234567890...",
  "imageUrl": "https://raw.githubusercontent.com/user/wallpaper-server/refs/heads/main/images/wallpaper-1234567890.png"
}
```

The `imageUrl` automatically uses the correct extension (`.png`, `.jpg`, `.webp`…) based on the uploaded file.

---

## Prerequisites

- **Node.js 20+**
- **Git** installed and configured on the host
- A **local clone** of the wallpaper GitHub repository with **push access** already configured (SSH key recommended)
- A Discord application with a bot user ([Discord Developer Portal](https://discord.com/developers/applications))

---

## Discord Developer Portal setup

### 1. Create the application & bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Under **Bot** → click **Reset Token** and copy your `DISCORD_TOKEN`
3. Under **General Information** → copy your `APPLICATION_ID` (this is `CLIENT_ID`)
4. Under **Bot** → **Privileged Gateway Intents**:
   - ✅ `Message Content Intent` — **NOT required** for slash commands. You can leave it off.

### 2. Invite the bot to your server

Build an OAuth2 URL in the **OAuth2 → URL Generator**:
- **Scopes**: `bot`, `applications.commands`
- **Bot permissions**: `Send Messages`, `Use Slash Commands`

Open the generated URL in your browser and invite the bot to your server.

### 3. Restrict who can use `/wallpaper` (optional)

In your Discord server:
**Server Settings → Integrations → [your bot] → /wallpaper → Manage**
Here you can limit the command to specific roles or users without any code changes.

---

## Local setup

```bash
# 1. Clone this repo
git clone https://github.com/your-user/discord-wallpaper-bot.git
cd discord-wallpaper-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values (see Configuration section below)

# 4. Verify git push access on the wallpaper repo
git -C /path/to/wallpaper-repo pull   # should work without prompting for credentials
git -C /path/to/wallpaper-repo push   # should work too

# 5. Start the bot
npm start
```

On first start, the bot will register the `/wallpaper` slash command and then connect to the Discord gateway.

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal |
| `CLIENT_ID` | ✅ | Application ID from the Developer Portal |
| `GUILD_ID` | — | Server ID for instant guild-scoped command registration. Omit for global (up to 1h propagation) |
| `REPO_PATH` | ✅ | Absolute path to the local git clone of the wallpaper repository |
| `GITHUB_RAW_BASE` | ✅ | Base URL for raw GitHub file access, e.g. `https://raw.githubusercontent.com/user/repo/refs/heads/main` |
| `IMAGE_SUBDIR` | — | Subdirectory inside the repo for images. Defaults to `images` |
| `JSON_FILE` | — | Relative path of the JSON manifest inside the repo. Defaults to `wallpaper.json` |
| `GIT_BRANCH` | — | Branch to pull from and push to (e.g. `main`). The bot checks out this branch before each update. Omit to use whatever branch the clone is already on |
| `GIT_USER_NAME` | — | Git commit author name. Defaults to `wallpaper-bot` |
| `GIT_USER_EMAIL` | — | Git commit author email. Defaults to `bot@example.com` |
| `AMEND_COMMITS` | — | Set to `true` to amend+force-push instead of regular commits. **Recommended** to prevent binary history bloat |

### `AMEND_COMMITS` explained

Git stores the full binary content of every committed file in history. If you use regular commits, every new wallpaper permanently adds its file size to the repo's total size on disk. After hundreds of wallpapers this adds up significantly.

Setting `AMEND_COMMITS=true` rewrites the last commit in place instead of adding a new one. The repo will always have a single commit and stay tiny — only the current wallpaper is stored.

**Downside**: you lose commit history (no log of past wallpapers). If you want history, keep `AMEND_COMMITS=false` but expect the repo to grow over time.

---

## Docker deployment (recommended for homelab / Proxmox)

### Build and run

```bash
# Copy and fill in your .env
cp .env.example .env

# Build image
docker build -t wallpaper-bot .

# Run (adjust paths to match your setup)
docker run -d \
  --name wallpaper-bot \
  --restart unless-stopped \
  --env-file .env \
  -e REPO_PATH=/repo \
  -v /home/user/repos/wallpaper-server:/repo \
  -v /home/user/.ssh:/root/.ssh:ro \
  wallpaper-bot
```

### Or with Docker Compose

```bash
# Edit REPO_PATH in .env first, then:
docker compose up -d
```

> **Note**: The `docker-compose.yml` mounts `${REPO_PATH}` from your host and overrides
> `REPO_PATH` inside the container to `/repo`. Your SSH keys are mounted read-only for git push.

### SSH key permissions inside the container

Make sure your SSH key is not world-readable, otherwise SSH will refuse to use it:

```bash
chmod 600 ~/.ssh/id_ed25519
```

If your GitHub remote uses HTTPS instead of SSH, embed the token in the remote URL:

```bash
git -C /path/to/repo remote set-url origin https://YOUR_TOKEN@github.com/user/repo.git
```

---

## Wallpaper repo structure

Your wallpaper GitHub repository should look like this after the first commit:

```
wallpaper-server/
├── images/
│   └── wallpaper-1234567890.png   ← current wallpaper (only one at a time)
└── wallpaper.json                 ← manifest consumed by your app/server
```

---

## Development

```bash
# Run with auto-restart on file changes (Node 20+)
npm run dev
```

To test without committing, temporarily set `AMEND_COMMITS=false` and use a test branch on your repo.

### Split branches (wallpaper vs bot code)

If `main` should only hold `wallpaper.json` and images while bot (or app) code lives on another branch (e.g. `discord-bot`):

1. Set `GIT_BRANCH=main` in `.env` so every `/wallpaper` run fetches, checks out `main`, and pushes there.
2. Keep `GITHUB_RAW_BASE` pointed at `main` (e.g. `.../refs/heads/main`).
3. Develop and merge bot code on `discord-bot` as usual; the mounted repo clone can be on any branch when the container starts.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `/wallpaper` command doesn't appear | Set `GUILD_ID` for instant registration; global commands take up to 1 hour |
| `git push` fails with auth error | Verify SSH key is mounted and `ssh -T git@github.com` works inside the container |
| `Interaction failed` in Discord | The bot took >3 seconds — check network/git speed; `deferReply()` gives 15 min budget |
| Hash always matches | The same image is being reposted — expected deduplication behaviour |
