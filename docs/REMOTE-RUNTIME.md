# Deploy Runtime to Remote Machine

## Context

NanoClaw containers are heavy (Claude SDK + Chromium). The operator (channels, routing, scheduling) is lightweight. The user wants to run containers on a separate machine. The remote machine checks out the same repo and builds from `main` — it's a proper deployment, not a patched-together NFS setup.

## Design

The repo gains a **worker** entry point (`src/worker.ts`). The remote machine checks out the repo, builds the container image, and runs `npm run worker`. The operator connects to it over HTTP/SSE.

```
Operator (this box)                    Runtime (remote)
├── NanoClaw process                   ├── git checkout of repo
│   ├── channels, scheduler            ├── nanoclaw-agent image (built locally)
│   ├── message loop                   ├── worker process (npm run worker)
│   └── container-runner               │   ├── credential proxy (local)
│       └── POST /spawn ──────────►    │   ├── docker run (local)
│          ◄── SSE stream ─────────    │   ├── IPC watcher (local)
│                                      │   ├── data/, groups/ (local)
│                                      │   └── sessions (local)
└── dashboard (:7722)                  └── worker HTTP (:7800)
```

### What lives where

**Operator**: channels, routing, scheduling, database, dashboard. Sends prompts to worker, receives results and IPC actions.

**Worker**: Docker, container image, credential proxy, IPC file watcher, all container mounts. Owns its own `data/` and `groups/` directories. Session data and group memory accumulate locally.

### Protocol

Worker runs an HTTP server (single endpoint with SSE streaming):

**`POST /spawn`** — Start a container
- Request body: `{ input: ContainerInput, groupConfig: { name, folder, isMain, timeout?, allowedHostPorts? }, env: { TZ, assistantName }, tasksSnapshot, groupsSnapshot }`
- Response: SSE stream (keeps connection open for container lifetime)
- Events streamed back:
  - `event: output` — output marker (result text, session ID, status)
  - `event: ipc` — outbound IPC action (send_message, schedule_task, host_exec request, etc.)
  - `event: phase` — agent phase change (initializing, working, responding, idle)
  - `event: exit` — container exited (exit code, duration)

**`POST /containers/:name/input`** — Send follow-up message to running container
- Body: `{ text: "..." }`
- Worker writes to local IPC input dir

**`POST /containers/:name/close`** — Signal container to wind down
- Worker writes `_close` sentinel to local IPC input dir

**`GET /health`** — Active containers, capacity

**Auth**: shared secret in header (`Authorization: Bearer <token>`), configured in both `.env` files.

### host_exec handling

When the container calls `host_exec`, the IPC watcher on the worker catches it. Two options:
- If the command targets an `additionalMount` that exists on the worker, execute locally
- Otherwise, forward to operator as an `ipc` SSE event; operator executes and POSTs result back via `/containers/:name/input`

For simplicity in v1: host_exec runs on the worker (the worker has the repo checkout, so most commands work). The operator can add paths to the worker's mount allowlist during deploy.

## Implementation

### New files

**`src/worker.ts`** (~200 lines) — HTTP server entry point
- Imports `runContainerAgent` mechanics from container-runner (or a shared subset)
- Manages local credential proxy (reads its own `.env` for API key)
- Manages local IPC watcher (subset of `src/ipc.ts` — only reads outbound messages/tasks, forwards as SSE events)
- Handles container lifecycle (spawn, input, close)
- Owns local `data/`, `groups/`, `container/` directories

**`src/remote-runner.ts`** (~150 lines) — Operator-side remote backend
- Called by container-runner when `CONTAINER_WORKER_URL` is configured
- POSTs spawn request to worker, opens SSE stream
- Translates SSE events back into the same callback interface (`onOutput`, `onProcess` equivalent)
- Handles follow-up messages via POST to worker
- Handles close signal via POST to worker

**`scripts/deploy-runtime.sh`** (~80 lines) — Deploy script
```bash
./scripts/deploy-runtime.sh user@host
```
1. SSH to remote, clone repo (or pull latest), `npm install`, `npm run build`
2. Build container image: `./container/build.sh`
3. Generate shared auth token, write to remote `.env` and operator `.env`
4. Copy operator's `.env` API credentials to remote `.env` (for credential proxy)
5. Set up systemd unit on remote: `nanoclaw-worker.service`
6. Write `CONTAINER_WORKER_URL=http://host:7800` to operator's `.env`
7. Start worker on remote
8. Print: restart NanoClaw to activate

### Modified files

**`src/container-runner.ts`**
- In `runContainerAgent()`: check `CONTAINER_WORKER_URL` config
- If set, delegate to `remote-runner.ts` instead of local `spawn()`
- Local path remains unchanged (default when no worker URL configured)

**`src/config.ts`**
- Add `CONTAINER_WORKER_URL` (env var, empty = local mode)
- Add `CONTAINER_WORKER_TOKEN` (shared auth secret)

**`package.json`**
- Add `"worker": "node dist/worker.ts"` script

### Unchanged files
- `container/` — Dockerfile, entrypoint, agent-runner (unchanged, runs on worker's Docker)
- `src/ipc.ts` — operator-side IPC stays the same for local mode; worker has its own IPC loop
- `src/group-queue.ts` — manages lifecycle the same way (process handle is an HTTP connection instead of ChildProcess, but queue logic unchanged)
- `src/index.ts` — no changes needed (container-runner abstracts the backend)

## Data persistence

Session data and group memory live on the worker machine. This is fine because:
- Sessions are per-group and only needed by the container runtime
- Group CLAUDE.md (agent memory) is read/written by the agent inside the container
- The operator never reads group folders directly — it sends formatted messages as prompts
- Conversation archives accumulate on the worker

If the worker is redeployed from scratch (fresh clone), sessions and group memory are lost. This is acceptable (agents start fresh) or could be handled by keeping `data/` and `groups/` outside the checkout (e.g., in `/var/lib/nanoclaw/`).

## Verification

1. On remote: `git clone`, `npm install`, `npm run build`, `./container/build.sh`
2. On remote: copy API key to `.env`, `npm run worker`
3. On operator: add `CONTAINER_WORKER_URL=http://remote:7800` to `.env`
4. Restart NanoClaw
5. Trigger agent via message
6. Dashboard shows active container
7. On remote: `docker ps` shows container
8. Agent responds normally
9. `./scripts/deploy-runtime.sh --remove` to revert to local
