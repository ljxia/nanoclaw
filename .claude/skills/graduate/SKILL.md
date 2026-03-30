---
name: graduate
description: Lift an agent workspace folder into a standalone git repo on GitHub and remount it back to the container with host_exec access. Use when an agent's project is ready to become a real repo.
allowed-tools: Bash(*), Read, Edit, AskUserQuestion
---

# Graduate Workspace to Repo

Promotes an agent workspace folder to a standalone GitHub repo at `~/src/<name>`, then remounts it so the agent can keep developing via `host_exec`.

## Phase 1 — Identify the project

Ask the user:
1. **Which group?** — show the list from `ls groups/` (exclude `global` and `main`)
2. **Which folder inside the workspace?** — list contents of `groups/<folder>/` and let them pick (exclude `CLAUDE.md`, `conversations/`, `logs/`, `.claude/`)
3. **Repo name** — suggest the folder name as default, confirm with user

Store these as `$GROUP_FOLDER`, `$PROJECT_DIR`, `$REPO_NAME`.

## Phase 2 — Copy to ~/src

```bash
cp -r "groups/$GROUP_FOLDER/$PROJECT_DIR" "$HOME/src/$REPO_NAME"
```

Do NOT move — keep the original as a fallback until the mount is confirmed working.

## Phase 2b — Gather related docs

Check the workspace for related research, planning, or vision documents outside the main project folder (e.g., `plan.md`, research directories, competitive analysis). Ask the user which ones to include and copy them into `docs/research/` in the new repo.

## Phase 3 — Initialize git repo

```bash
cd "$HOME/src/$REPO_NAME"
git init
git add -A
git commit -m "Initial commit (graduated from $GROUP_FOLDER workspace)"
```

If there's already a `.git` directory in the copied folder, skip `git init` — just ensure the working tree is clean.

Review for secrets before committing. If you spot `.env`, credentials, API keys, or tokens in the tree, warn the user and add them to `.gitignore` before the initial commit.

## Phase 4 — Create GitHub repo and push

```bash
gh repo create "$REPO_NAME" --private --source "$HOME/src/$REPO_NAME" --push
```

If the user has a preferred GitHub org or account, use `--owner` flag. Confirm the repo URL with the user after creation.

## Phase 5 — Choose target group

Ask the user whether to:

1. **Mount to the original group** — the agent in `$GROUP_FOLDER` gets the repo mount. Simple, but development chatter stays in the same channel as ideation.

2. **Create a dedicated project group** (recommended for active development) — spin up a new channel specifically for this project, keeping the original group clean for ideation and research.

If the user chooses option 2:

### Creating a dedicated project group

The user needs to create a new channel on their platform first (you can't do this via API for all channels):

- **Discord**: Ask the user to create a new channel in their server (e.g., `#overbilled-dev`). They can provide the channel ID, or send a message there and NanoClaw will auto-discover it.
- **Telegram**: Ask the user to create a new group and add the bot.
- **Slack**: Ask the user to create a new channel and invite the bot.

Once the new channel exists, register it:

```bash
# Get the new channel's JID (the user provides it, or it appears in logs after first message)
# Discord example: dc:<channel_id>
# Telegram example: tg:<chat_id>

# Register directly via DB insert
npx tsx -e "
import Database from 'better-sqlite3';
import path from 'path';
const db = new Database(path.join('store', 'messages.db'));
db.prepare(\`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)\`).run(
  '$NEW_JID',
  '$REPO_NAME',
  '$NEW_FOLDER',    // e.g. discord_overbilled-dev
  null,             // inherits default trigger
  new Date().toISOString(),
  null,
  0
);
db.close();
"
```

Create the group folder:
```bash
mkdir -p "groups/$NEW_FOLDER"
```

Copy the original group's CLAUDE.md as a starting point, then tailor it for development context:
```bash
cp "groups/$GROUP_FOLDER/CLAUDE.md" "groups/$NEW_FOLDER/CLAUDE.md"
```

Store the target as `$TARGET_FOLDER` (either `$GROUP_FOLDER` or `$NEW_FOLDER`).

## Phase 6 — Mount the repo

Use the existing mount script to register the mount for the target group:

```bash
cd /home/sakaki/src/nanoclaw
npx tsx scripts/set-group-mount.ts "$TARGET_FOLDER" "$HOME/src/$REPO_NAME"
```

This mounts as **read-write** by default (no `--readonly` flag), which enables `host_exec`. The mount appears inside the container at `/workspace/extra/$REPO_NAME`.

### Port bridging considerations

Ask the user if the project runs a dev server. If so, there are two patterns:

1. **Direct host process** — the agent runs `npm run dev` via host_exec and the dev server binds a port on the host. Add `--ports <PORT>` to the mount command so the container can reach it.

2. **Dockerized dev environment** — the project runs in its own Docker container (e.g., `docker compose up`). In this case you need to:
   - Reserve a dedicated port that doesn't conflict with other projects
   - Bind the project's Docker container to that port on the host
   - Add `--ports <PORT>` so the agent container can reach the project's Docker container via the host network

   This is common for graduated projects since they often outgrow bare `npm run dev`. If the user isn't sure yet, skip ports and document that they can add them later:
   ```bash
   npx tsx scripts/set-group-mount.ts "$TARGET_FOLDER" "$HOME/src/$REPO_NAME" --ports <PORT>
   ```

If no ports are needed now, register the mount without `--ports` — it can be updated later by re-running the script.

## Phase 7 — Clean up the original

After confirming the mount is registered, remove the original workspace copy:

```bash
rm -rf "groups/$GROUP_FOLDER/$PROJECT_DIR"
```

Confirm with the user before deleting.

## Phase 8 — Restart NanoClaw

Restart the service so the new mount takes effect:

```bash
systemctl --user restart nanoclaw
```

## Phase 9 — Verify

Print a summary:
- Repo URL (from `gh repo view --json url -q .url`)
- Mount path inside container: `/workspace/extra/$REPO_NAME`
- Target group: `$TARGET_FOLDER` (note if this is a new dedicated group)
- Original group: `$GROUP_FOLDER` (if different from target — still available for ideation)
- host_exec: enabled (read-write mount)

Remind the user that the agent can now use `host_exec` with cwd `/workspace/extra/$REPO_NAME` to run commands on the host (build, test, serve, etc). All standard host_exec conventions apply — the shell is sandboxed to the mount root, timeout defaults to 10 minutes, and output is capped at 200KB.

If a dedicated group was created, note that the original group retains its workspace, conversation history, and research context — it stays focused on ideation while the new group handles active development.
