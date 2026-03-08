import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  TextChannel,
  Message,
} from 'discord.js';

import { readEnvFile } from './env.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Config
const CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID || '1479498339471982614';
const PORT = parseInt(process.env.APPROVAL_PORT || '7711', 10);
const TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT || '600000', 10);

const APPROVE_EMOJI = '👍';
const DENY_EMOJI = '👎';
const ALWAYS_EMOJI = '🤘';
const SESSION_EMOJI = '⏩';
const CONTINUE_EMOJI = '▶️';
const STOP_EMOJI = '⏹️';

const SESSION_APPROVE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// Read bot token from .env
const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
const BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error('DISCORD_BOT_TOKEN not set');
  process.exit(1);
}

// Discord client — partials required to receive events on uncached messages
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

let channel: TextChannel | null = null;
let lastUserId: string | null = null;

// Send to Discord with trailing blank line for visual separation
function sendToChannel(
  text: string,
  mention = false,
): Promise<Message | undefined> {
  const prefix = mention && lastUserId ? `<@${lastUserId}> ` : '';
  return (
    channel?.send(`${prefix}${text}\n\u200b`) ?? Promise.resolve(undefined)
  );
}

interface PendingRequest {
  resolve: (result: {
    decision: string;
    text?: string;
    always?: boolean;
  }) => void;
  msg: Message;
  input?: Record<string, unknown>;
}

// Track pending approval requests by Discord message ID
const pendingApprovals = new Map<string, PendingRequest>();

// Track session-level auto-approvals (session ID -> expiry timestamp)
const sessionAutoApprovals = new Map<string, number>();

// Track pending text replies (for AskUserQuestion)
const pendingQuestions = new Map<string, PendingRequest>();

// Track pending stop decisions (continue or let stop)
const pendingStops = new Map<string, PendingRequest>();

// Track stopped sessions by Discord message ID (for resume via reply)
const stoppedSessions = new Map<string, { sessionId: string; cwd: string }>();

const ACK_ALLOW = '🆗';
const ACK_DENY = '🫡';
const ACK_ANSWER = '🆗';
const ACK_TIMEOUT = '⏰';

function ack(msg: Message, emoji: string): void {
  msg.react(emoji).catch(() => {});
}

// Delete a consumed reply so NanoClaw doesn't process it as a regular message
function consume(message: Message): void {
  message.delete().catch(() => {});
}

// Counter for short tmux session names
let tmuxCounter = 0;

// Resume a stopped Claude Code session in a tmux window
async function resumeSession(
  sessionId: string,
  cwd: string,
  prompt: string,
  replyTo: Message,
): Promise<void> {
  ack(replyTo, '🔄');

  const shortCwd = cwd.split('/').slice(-1)[0] || 'claude';
  const tmuxName = `cc-${shortCwd}-${tmuxCounter++}`;

  // Spawn tmux session with claude --resume and the user's prompt
  const tmux = spawn(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      tmuxName,
      '-c',
      cwd,
      'claude',
      '--resume',
      sessionId,
      prompt,
    ],
    {
      env: { ...process.env, HOME: process.env.HOME },
      stdio: 'ignore',
    },
  );

  tmux.on('close', (code) => {
    if (code === 0) {
      sendToChannel(
        `▶️ Resumed in tmux session **${tmuxName}**\n\`\`\`\ntmux attach -t ${tmuxName}\n\`\`\``,
      );
    } else {
      sendToChannel(`❌ Failed to create tmux session (exit ${code})`);
    }
  });

  tmux.on('error', (err) => {
    sendToChannel(`❌ Failed to resume: ${err.message}`);
  });
}

// Build a Claude Code permission pattern from tool input
function buildPermissionPattern(input: Record<string, unknown>): string | null {
  const tool = (input.tool_name as string) || '';
  const params = (input.tool_input as Record<string, unknown>) || {};

  if (tool === 'Bash') {
    const cmd = (params.command as string) || '';
    // Use the first word (binary) as the pattern prefix
    const bin = cmd.split(/\s/)[0];
    if (bin) return `Bash(${bin}:*)`;
  } else if (tool === 'Edit' || tool === 'Write') {
    const filePath = (params.file_path as string) || '';
    if (filePath) return `${tool}(${filePath})`;
  }
  return null;
}

// Add a permission pattern to ~/.claude/settings.json
function addToAllowlist(pattern: string): void {
  const settingsPath = path.join(
    process.env.HOME || '',
    '.claude',
    'settings.json',
  );
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    if (!settings.permissions.allow.includes(pattern)) {
      settings.permissions.allow.push(pattern);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`Added to allowlist: ${pattern}`);
    }
  } catch (err) {
    console.error('Failed to update allowlist:', err);
  }
}

// Handle reactions
client.on(Events.MessageReactionAdd, (reaction, user) => {
  if (user.bot) return;
  lastUserId = user.id;
  const msgId = reaction.message.id;
  const emoji = reaction.emoji.name;

  // Check pending approvals
  const pending = pendingApprovals.get(msgId);
  if (pending) {
    if (emoji === APPROVE_EMOJI) {
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_ALLOW);
      pending.resolve({ decision: 'allow' });
    } else if (emoji === DENY_EMOJI) {
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_DENY);
      pending.resolve({ decision: 'deny' });
    } else if (emoji === ALWAYS_EMOJI) {
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_ALLOW);
      pending.resolve({ decision: 'allow', always: true });
    } else if (emoji === SESSION_EMOJI) {
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_ALLOW);
      // Auto-approve this session for 5 minutes
      const sessionId = (pending.input?.session_id as string) || '';
      if (sessionId) {
        const expiry = Date.now() + SESSION_APPROVE_DURATION_MS;
        sessionAutoApprovals.set(sessionId, expiry);
        const mins = SESSION_APPROVE_DURATION_MS / 60000;
        sendToChannel(
          `⏩ Auto-approving session \`${sessionId.slice(0, 8)}…\` for ${mins} minutes`,
        );
      }
      pending.resolve({ decision: 'allow' });
    }
    return;
  }

  // Check pending stop decisions
  const pendingStop = pendingStops.get(msgId);
  if (pendingStop) {
    if (emoji === CONTINUE_EMOJI) {
      pendingStops.delete(msgId);
      ack(pendingStop.msg, '▶️');
      pendingStop.resolve({ decision: 'deny' }); // deny = don't stop = continue
    } else if (emoji === STOP_EMOJI) {
      pendingStops.delete(msgId);
      ack(pendingStop.msg, '⏹️');
      pendingStop.resolve({ decision: 'allow' }); // allow = let it stop
    }
    return;
  }
});

// Handle text replies (for questions and targeted approval replies)
client.on(Events.MessageCreate, (message: Message) => {
  if (message.author.bot) return;
  if (message.channelId !== CHANNEL_ID) return;

  lastUserId = message.author.id;

  const refId = message.reference?.messageId;
  const content = message.content.trim();
  const c = content.toLowerCase();

  console.log(
    `Message: "${content}" refId=${refId || 'none'} pending=${pendingApprovals.size} questions=${pendingQuestions.size} pendingIds=[${[...pendingQuestions.keys()].join(',')}]`,
  );

  // Threaded reply to a specific message
  if (refId) {
    // Reply to a stopped session — resume it
    if (stoppedSessions.has(refId)) {
      const { sessionId, cwd } = stoppedSessions.get(refId)!;
      consume(message);
      resumeSession(sessionId, cwd, content, message);
      return;
    }

    console.log(
      `  refId lookup: questions.has=${pendingQuestions.has(refId)} approvals.has=${pendingApprovals.has(refId)}`,
    );
    // Reply to a pending question
    if (pendingQuestions.has(refId)) {
      const pending = pendingQuestions.get(refId)!;
      pendingQuestions.delete(refId);
      console.log(`  Resolved question with: "${content}"`);
      ack(pending.msg, ACK_ANSWER);
      consume(message);
      pending.resolve({ decision: 'deny', text: content });
      return;
    }
    // Reply to a pending approval
    if (pendingApprovals.has(refId)) {
      const pending = pendingApprovals.get(refId)!;
      if (['yes', 'y', 'approve', 'ok'].includes(c)) {
        pendingApprovals.delete(refId);
        console.log(`  Resolved approval: allow`);
        ack(pending.msg, ACK_ALLOW);
        consume(message);
        pending.resolve({ decision: 'allow' });
      } else if (['no', 'n', 'deny', 'reject'].includes(c)) {
        pendingApprovals.delete(refId);
        console.log(`  Resolved approval: deny`);
        ack(pending.msg, ACK_DENY);
        consume(message);
        pending.resolve({ decision: 'deny' });
      }
      return;
    }
    // Reply to a pending stop — text reply means "continue with these instructions"
    if (pendingStops.has(refId)) {
      const pending = pendingStops.get(refId)!;
      pendingStops.delete(refId);
      console.log(`  Resolved stop with instructions: "${content}"`);
      ack(pending.msg, ACK_ANSWER);
      consume(message);
      pending.resolve({ decision: 'deny', text: content });
      return;
    }
  }

  // Non-threaded: answer oldest pending question
  if (pendingQuestions.size > 0) {
    const [msgId, pending] = pendingQuestions.entries().next().value!;
    pendingQuestions.delete(msgId);
    ack(pending.msg, ACK_ANSWER);
    consume(message);
    pending.resolve({ decision: 'deny', text: content });
    return;
  }

  // Non-threaded: y/n for oldest pending approval
  if (pendingApprovals.size > 0) {
    if (['yes', 'y', 'approve', 'ok'].includes(c)) {
      const [msgId, pending] = pendingApprovals.entries().next().value!;
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_ALLOW);
      consume(message);
      pending.resolve({ decision: 'allow' });
    } else if (['no', 'n', 'deny', 'reject'].includes(c)) {
      const [msgId, pending] = pendingApprovals.entries().next().value!;
      pendingApprovals.delete(msgId);
      ack(pending.msg, ACK_DENY);
      consume(message);
      pending.resolve({ decision: 'deny' });
    }
    return;
  }

  // Non-threaded: any text for oldest pending stop = instructions to continue
  if (pendingStops.size > 0) {
    const [msgId, pending] = pendingStops.entries().next().value!;
    pendingStops.delete(msgId);
    ack(pending.msg, ACK_ANSWER);
    consume(message);
    pending.resolve({ decision: 'deny', text: content });
  }
});

// Format tool call
function formatTool(input: Record<string, unknown>): string {
  const tool = (input.tool_name as string) || 'Unknown';
  const params = (input.tool_input as Record<string, unknown>) || {};

  switch (tool) {
    case 'Bash': {
      const cmd = (params.command as string) || '(empty)';
      const desc = params.description ? `\n${params.description}` : '';
      return `**Bash**\n\`\`\`\n${cmd.slice(0, 800)}\n\`\`\`${desc}`;
    }
    case 'Write':
      return `**Write** \`${params.file_path || '?'}\`\n(${((params.content as string) || '').length} chars)`;
    case 'Edit':
      return `**Edit** \`${params.file_path || '?'}\``;
    case 'NotebookEdit':
      return `**NotebookEdit** \`${params.notebook_path || '?'}\``;
    default:
      return `**${tool}**\n\`\`\`json\n${JSON.stringify(params, null, 2).slice(0, 400)}\n\`\`\``;
  }
}

// Format AskUserQuestion
function formatQuestion(input: Record<string, unknown>): string {
  const params = (input.tool_input as Record<string, unknown>) || {};
  const questions = (params.questions as Array<Record<string, unknown>>) || [];

  return questions
    .map((q) => {
      const text = (q.question as string) || '';
      const options = (q.options as Array<Record<string, unknown>>) || [];
      const optionList = options
        .map(
          (o, i) =>
            `${i + 1}. **${(o.label as string) || ''}** — ${(o.description as string) || ''}`,
        )
        .join('\n');
      return `${text}\n${optionList}`;
    })
    .join('\n\n');
}

// Check if a tool call is already in Claude Code's allowlist (same settings.json)
function isAllowlisted(input: Record<string, unknown>): boolean {
  const settingsPath = path.join(
    process.env.HOME || '',
    '.claude',
    'settings.json',
  );
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const allowList: string[] = settings?.permissions?.allow || [];
    const tool = (input.tool_name as string) || '';
    const params = (input.tool_input as Record<string, unknown>) || {};

    for (const pattern of allowList) {
      if (!pattern.startsWith(`${tool}(`)) continue;
      const inner = pattern.slice(tool.length + 1, -1); // strip Tool( and )

      if (tool === 'Bash') {
        const cmd = (params.command as string) || '';
        const bin = cmd.split(/\s/)[0];
        if (inner.endsWith(':*')) {
          const prefix = inner.slice(0, -2);
          if (bin === prefix || cmd.startsWith(prefix)) return true;
        } else if (inner === cmd) {
          return true;
        }
      } else if (tool === 'WebFetch' || tool === 'WebSearch') {
        // These are typically allowlisted as just "WebFetch" or "WebSearch"
        return true;
      }
    }

    // Also check bare tool names (e.g. "WebSearch" without parens)
    if (allowList.includes(tool)) return true;
  } catch {
    // Can't read settings — don't auto-approve
  }
  return false;
}

// Send approval request and wait for reaction
async function handleApproval(
  input: Record<string, unknown>,
): Promise<{ decision: string; text?: string; always?: boolean }> {
  // Auto-approve if already in allowlist
  if (isAllowlisted(input)) {
    return { decision: 'allow' };
  }

  // Auto-approve if session has a temporary blanket approval
  const sessionId = (input.session_id as string) || '';
  if (sessionId && sessionAutoApprovals.has(sessionId)) {
    const expiry = sessionAutoApprovals.get(sessionId)!;
    if (Date.now() < expiry) {
      return { decision: 'allow' };
    }
    sessionAutoApprovals.delete(sessionId);
  }

  if (!channel) throw new Error('Discord channel not ready');

  const toolName = (input.tool_name as string) || '';
  const isQuestion = toolName === 'AskUserQuestion';
  const cwd = (input.cwd as string) || '';
  const shortCwd = cwd.split('/').slice(-2).join('/');

  let msg: Message;

  if (isQuestion) {
    const questionText = formatQuestion(input);
    msg = (await sendToChannel(`❓ **${shortCwd}**\n${questionText}`, true))!;
  } else {
    const toolDesc = formatTool(input);
    msg = (await sendToChannel(`🔐 **${shortCwd}**\n${toolDesc}`, true))!;
    await msg.react(APPROVE_EMOJI);
    await msg.react(DENY_EMOJI);
    await msg.react(ALWAYS_EMOJI);
    await msg.react(SESSION_EMOJI);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (isQuestion) {
        pendingQuestions.delete(msg.id);
      } else {
        pendingApprovals.delete(msg.id);
      }
      ack(msg, ACK_TIMEOUT);
      resolve({
        decision: 'deny',
        text: isQuestion ? '(no answer — timed out)' : undefined,
      });
    }, TIMEOUT_MS);

    const wrappedResolve = (result: {
      decision: string;
      text?: string;
      always?: boolean;
    }) => {
      clearTimeout(timeout);
      resolve(result);
    };

    if (isQuestion) {
      pendingQuestions.set(msg.id, { resolve: wrappedResolve, msg });
    } else {
      pendingApprovals.set(msg.id, { resolve: wrappedResolve, msg, input });
    }
  });
}

// Handle Stop hook — post summary to Discord, wait for continue/stop decision
async function handleStop(
  input: Record<string, unknown>,
): Promise<{ decision: string; reason?: string }> {
  if (!channel) throw new Error('Discord channel not ready');

  const cwd = (input.cwd as string) || '';
  const shortCwd = cwd.split('/').slice(-2).join('/');
  const permMode = (input.permission_mode as string) || '';
  const modeLabel = permMode === 'plan' ? ' (plan mode)' : '';
  const summary = (input.last_assistant_message as string) || '';
  const sessionId = (input.session_id as string) || '';

  const truncated =
    summary.length > 1500 ? summary.slice(0, 1500) + '…' : summary;
  const msg = (await sendToChannel(
    `⏸️ **${shortCwd}**${modeLabel} wants to stop\n${truncated}\n\nReact ${CONTINUE_EMOJI} to continue or ${STOP_EMOJI} to let it stop. Or reply with instructions.`,
    true,
  ))!;
  await msg.react(CONTINUE_EMOJI);
  await msg.react(STOP_EMOJI);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingStops.delete(msg.id);
      ack(msg, ACK_TIMEOUT);
      // On timeout, allow stop and record session for resume
      if (sessionId) {
        stoppedSessions.set(msg.id, { sessionId, cwd });
        if (stoppedSessions.size > 50) {
          const oldest = stoppedSessions.keys().next().value!;
          stoppedSessions.delete(oldest);
        }
      }
      resolve({ decision: 'allow' });
    }, TIMEOUT_MS);

    const wrappedResolve = (result: { decision: string; text?: string }) => {
      clearTimeout(timeout);
      if (result.decision === 'allow') {
        // Stopping — record session for resume via reply
        if (sessionId) {
          stoppedSessions.set(msg.id, { sessionId, cwd });
          if (stoppedSessions.size > 50) {
            const oldest = stoppedSessions.keys().next().value!;
            stoppedSessions.delete(oldest);
          }
        }
        resolve({ decision: 'allow' });
      } else if (result.text) {
        // User replied with instructions — block stop and forward them
        resolve({
          decision: 'block',
          reason: `User replied via Discord: ${result.text}`,
        });
      } else {
        // Continue emoji — block stop with generic reason
        resolve({
          decision: 'block',
          reason:
            'User chose to continue via Discord. Ask the user what they would like to do next using AskUserQuestion.',
        });
      }
    };

    pendingStops.set(msg.id, { resolve: wrappedResolve, msg });
  });
}

// Handle wallet approval — display transaction details and wait for reaction
async function handleWalletApproval(
  input: Record<string, unknown>,
): Promise<{ approved: boolean }> {
  if (!channel) throw new Error('Discord channel not ready');

  const txType = (input.type as string) || '';
  const wallet = (input.wallet as string) || 'main';
  const requestedBy = (input.requestedBy as string) || 'unknown';

  let text: string;
  if (txType === 'wallet_send_transaction') {
    const chain = (input.chain as string) || '?';
    const to = (input.to as string) || '?';
    const value = (input.value as string) || '?';
    const token = input.token as string | null;
    const memo = (input.memo as string) || 'No reason provided';
    const tokenLabel = token ? `Token: \`${token}\`\n` : '';

    text =
      `💰 **Transaction Approval**\n\n` +
      `**Wallet:** ${wallet}\n` +
      `**Chain:** ${chain}\n` +
      `**To:** \`${to}\`\n` +
      `**Amount:** ${value}${token ? '' : ' ETH'}\n` +
      `${tokenLabel}` +
      `**Reason:** ${memo}\n` +
      `**Group:** ${requestedBy}\n\n` +
      `React ${APPROVE_EMOJI} to approve or ${DENY_EMOJI} to deny`;
  } else if (txType === 'wallet_sign_message') {
    const message = (input.message as string) || '?';
    const memo = (input.memo as string) || 'No reason provided';

    text =
      `✍️ **Message Signing Request**\n\n` +
      `**Wallet:** ${wallet}\n` +
      `**Message:** \`\`\`\n${message.slice(0, 500)}\n\`\`\`\n` +
      `**Reason:** ${memo}\n` +
      `**Group:** ${requestedBy}\n\n` +
      `React ${APPROVE_EMOJI} to sign or ${DENY_EMOJI} to deny`;
  } else {
    return { approved: false };
  }

  const msg = (await sendToChannel(text, true))!;
  await msg.react(APPROVE_EMOJI);
  await msg.react(DENY_EMOJI);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingApprovals.delete(msg.id);
      ack(msg, ACK_TIMEOUT);
      resolve({ approved: false });
    }, TIMEOUT_MS);

    const wrappedResolve = (result: { decision: string }) => {
      clearTimeout(timeout);
      resolve({ approved: result.decision === 'allow' });
    };

    pendingApprovals.set(msg.id, { resolve: wrappedResolve, msg });
  });
}

// HTTP server
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/request') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const input = JSON.parse(body);

        handleApproval(input).then(({ decision, text, always }) => {
          const toolName = (input.tool_name as string) || '';
          const isQuestion = toolName === 'AskUserQuestion';

          // Add to allowlist if "always allow" was chosen
          if (always) {
            const pattern = buildPermissionPattern(input);
            if (pattern) {
              addToAllowlist(pattern);
              sendToChannel(`🔓 Added to allowlist: \`${pattern}\``);
            }
          }

          let reason: string;
          if (isQuestion && text) {
            reason = `User answered via Discord: ${text}`;
          } else {
            reason =
              decision === 'allow'
                ? 'Approved via Discord'
                : 'Denied via Discord';
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: decision,
                permissionDecisionReason: reason,
              },
            }),
          );
        });
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else if (req.method === 'POST' && req.url === '/stop') {
    // Stop hook endpoint — posts summary to Discord and waits for
    // user decision (continue working or let it stop).
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const input = JSON.parse(body);

        handleStop(input).then(({ decision, reason }) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (decision === 'block') {
            res.end(JSON.stringify({ decision: 'block', reason }));
          } else {
            // Allow stop — empty JSON lets Claude stop normally
            res.end('{}');
          }
        });
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else if (req.method === 'POST' && req.url === '/notify') {
    // Fire-and-forget notification (Stop fallthrough, SessionEnd, etc.)
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        const cwd = (input.cwd as string) || '';
        const shortCwd = cwd.split('/').slice(-2).join('/');
        const hookEvent = (input.hook_event_name as string) || '';
        const permMode = (input.permission_mode as string) || '';
        const sessionId = (input.session_id as string) || '';

        // Stop hooks have last_assistant_message; SessionEnd has reason
        const summary = (input.last_assistant_message as string) || '';
        const endReason = (input.reason as string) || '';

        let text: string;
        if (hookEvent === 'SessionEnd') {
          const modeLabel = permMode === 'plan' ? ' (plan mode)' : '';
          text = `🔚 **${shortCwd}**${modeLabel} session ended: ${endReason}`;
        } else {
          const modeLabel = permMode === 'plan' ? ' (plan mode)' : '';
          text = summary
            ? `⏹️ **${shortCwd}**${modeLabel} stopped\n${summary.slice(0, 1500)}`
            : `⏹️ **${shortCwd}**${modeLabel} stopped`;
        }

        sendToChannel(text)
          .then((sentMsg) => {
            if (sentMsg && sessionId) {
              stoppedSessions.set(sentMsg.id, { sessionId, cwd });
              // Keep last 50 sessions to avoid unbounded growth
              if (stoppedSessions.size > 50) {
                const oldest = stoppedSessions.keys().next().value!;
                stoppedSessions.delete(oldest);
              }
            }
          })
          .catch(() => {});
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else if (req.method === 'POST' && req.url === '/wallet-approve') {
    // Wallet transaction/signing approval endpoint
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const input = JSON.parse(body);

        handleWalletApproval(input).then(({ approved }) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ approved }));
        });
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: 'ok',
        discord: client.isReady(),
        pending: pendingApprovals.size,
        questions: pendingQuestions.size,
        stops: pendingStops.size,
        sessionAutoApprovals: Object.fromEntries(
          [...sessionAutoApprovals].map(([id, exp]) => [
            id.slice(0, 8),
            Math.max(0, Math.round((exp - Date.now()) / 1000)),
          ]),
        ),
      }),
    );
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Start
client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord connected as ${readyClient.user.tag}`);

  const ch = readyClient.channels.cache.get(CHANNEL_ID);
  if (!ch || !('send' in ch)) {
    console.error(`Channel ${CHANNEL_ID} not found or not text-based`);
    process.exit(1);
  }
  channel = ch as TextChannel;
  console.log(`Approval channel: #${channel.name}`);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`HTTP server on http://127.0.0.1:${PORT}`);
    console.log(`Timeout: ${TIMEOUT_MS}ms`);
  });
});

client.login(BOT_TOKEN);
