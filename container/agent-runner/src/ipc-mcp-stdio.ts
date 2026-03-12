/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'list_groups',
  'List all available chat groups/channels that can be registered. Shows JID, name, channel, and registration status.',
  {},
  async () => {
    const groupsFile = path.join(IPC_DIR, 'available_groups.json');
    try {
      const data = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
      const groups = data.groups || [];
      if (groups.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No groups available.' }] };
      }
      const lines = groups.map((g: { jid: string; name: string; lastActivity: string; isRegistered: boolean }) =>
        `- ${g.name} (${g.jid}) ${g.isRegistered ? '[REGISTERED]' : '[not registered]'} — last activity: ${g.lastActivity}`
      );
      return { content: [{ type: 'text' as const, text: `Available groups:\n${lines.join('\n')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to read available groups: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use the list_groups tool to find available groups and their JIDs. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "line_sakaki-labs", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'host_exec',
  `Run a shell command on the HOST machine in a mounted directory. This executes outside the container, on the actual host.

IMPORTANT: Before running commands, always read the project's manifest files first (package.json, Makefile, docker-compose.yml, Justfile, etc.) to discover existing scripts and targets. Use the project's own defined commands (e.g. "npm test", "make deploy", "docker compose up -d") rather than inventing ad-hoc shell commands. The project maintainers know their build/test/deploy pipeline best.

Output (stdout, stderr, exit code) is returned as a structured exec_result message.

Example workflow:
1. Read /workspace/extra/rolypoly/package.json to find available scripts
2. Edit source files
3. host_exec({ command: "npm test", cwd: "/workspace/extra/rolypoly" })
4. host_exec({ command: "npm run deploy", cwd: "/workspace/extra/rolypoly" })

Security: only directories mounted into your container via additionalMounts are allowed. Read-only mounts are rejected.`,
  {
    command: z.string().describe('Shell command to run on the host'),
    cwd: z.string().describe('Container-visible path (e.g. "/workspace/extra/rolypoly")'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 5 minutes)'),
  },
  async (args) => {
    const requestId = `hexec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'host_exec',
      command: args.command,
      cwd: args.cwd,
      timeout: args.timeout,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Executing on host (${requestId}): ${args.command}\nResult will arrive via exec_result message.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Wallet tools — signing oracle (key never in container)
// ---------------------------------------------------------------------------

server.tool(
  'wallet_create',
  `Create a new wallet with a random private key. Main group only.

The key is generated and encrypted on the host — you never see it.
Returns the new wallet's address. The wallet is immediately usable
with all wallet_* tools.

Use cases:
• Disposable wallets for testing or one-off operations
• Separate wallets per project or purpose
• Multi-wallet strategies (e.g. hot wallet for small ops)

The new wallet inherits the same chain configuration as the main wallet
unless you specify chains explicitly.`,
  {
    wallet_name: z.string().describe('Name for the new wallet (e.g. "test-1", "project-fund")'),
    chains: z.array(z.string()).optional().describe('Chains to enable (defaults to same as main wallet)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create wallets.' }],
        isError: true,
      };
    }
    const requestId = `wcreate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_create',
      walletName: args.wallet_name,
      chains: args.chains,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Wallet creation requested for "${args.wallet_name}" (${requestId}). Result will arrive via message.` }],
    };
  },
);

server.tool(
  'wallet_get_address',
  `Get the address and supported chains for a wallet. Read-only, no approval needed.

Returns the public address and list of chains the wallet is configured for.
Use this to check which wallets are available and what chains they support.`,
  {
    wallet_name: z.string().default('main').describe('Wallet name (default "main")'),
  },
  async (args) => {
    const requestId = `waddr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_get_address',
      walletName: args.wallet_name,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Address lookup requested (${requestId}). Result will arrive via message.` }],
    };
  },
);

server.tool(
  'wallet_get_balance',
  `Check wallet balance on a specific chain. Read-only, no approval needed.

Returns the balance in human-readable units (e.g. "1.5" ETH).
For ERC-20 tokens, provide the token contract address.`,
  {
    wallet_name: z.string().default('main').describe('Wallet name (default "main")'),
    chain: z.string().describe('Chain name (e.g. "ethereum", "base", "arbitrum")'),
    token: z.string().optional().describe('ERC-20 contract address (omit for native ETH)'),
  },
  async (args) => {
    const requestId = `wbal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_get_balance',
      walletName: args.wallet_name,
      chain: args.chain,
      token: args.token,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Balance check requested for ${args.wallet_name} on ${args.chain} (${requestId}).` }],
    };
  },
);

server.tool(
  'wallet_estimate_gas',
  `Estimate gas cost for a transaction. Read-only, no approval needed.

Returns gas estimate and cost in ETH. Use this before wallet_send_transaction
to show the user expected costs.`,
  {
    chain: z.string().describe('Chain name'),
    to: z.string().describe('Recipient address'),
    value: z.string().describe('Amount in human-readable units (e.g. "0.5")'),
    token: z.string().optional().describe('ERC-20 contract address (omit for native)'),
  },
  async (args) => {
    const requestId = `wgas-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_estimate_gas',
      chain: args.chain,
      to: args.to,
      value: args.value,
      token: args.token,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Gas estimate requested (${requestId}).` }],
    };
  },
);

server.tool(
  'wallet_send_transaction',
  `Send ETH or ERC-20 tokens from the wallet. REQUIRES human approval via Discord.

The host constructs and signs the transaction — you never see the private key.
The user will see the exact recipient, amount, and gas cost before approving.

Always call wallet_estimate_gas first so you can tell the user the expected cost.
Always include a memo explaining why the transaction is needed.`,
  {
    wallet_name: z.string().default('main').describe('Wallet name'),
    chain: z.string().describe('Chain name (e.g. "ethereum", "base")'),
    to: z.string().describe('Recipient address (0x...)'),
    value: z.string().describe('Amount in human-readable units (e.g. "0.5" for 0.5 ETH)'),
    token: z.string().optional().describe('ERC-20 contract address (omit for native ETH)'),
    memo: z.string().describe('Reason for transaction — shown to user in approval prompt'),
  },
  async (args) => {
    const requestId = `wtx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_send_transaction',
      walletName: args.wallet_name,
      chain: args.chain,
      to: args.to,
      value: args.value,
      token: args.token,
      memo: args.memo,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Transaction submitted for approval (${requestId}). Waiting for user to approve via Discord. Result will arrive via message.` }],
    };
  },
);

server.tool(
  'wallet_sign_message',
  `Sign an arbitrary message with the wallet. REQUIRES human approval via Discord.

The user will see the exact message being signed before approving.
Always include a memo explaining why signing is needed.

WARNING: Signed messages can authorize actions on-chain (e.g. login, permits).
Only request signing when the user has explicitly asked for it.`,
  {
    wallet_name: z.string().default('main').describe('Wallet name'),
    message: z.string().describe('Message to sign'),
    memo: z.string().describe('Reason for signing — shown to user in approval prompt'),
  },
  async (args) => {
    const requestId = `wsig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_sign_message',
      walletName: args.wallet_name,
      message: args.message,
      memo: args.memo,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Signing request submitted for approval (${requestId}). Waiting for user to approve via Discord.` }],
    };
  },
);

server.tool(
  'wallet_tx_history',
  `View recent wallet transaction history. Read-only.

Returns the last 50 transactions with status, hash, amount, and timestamp.
Main group sees all transactions; other groups see only their own.`,
  {},
  async () => {
    const requestId = `whist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'wallet_tx_history',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Transaction history requested (${requestId}).` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
