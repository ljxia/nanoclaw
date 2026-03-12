import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import fs from 'node:fs';
import path from 'node:path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualReconnecting = false;

  // Backoff: 5s, 10s, 20s, 40s, 80s, 160s, 300s (cap)
  private static readonly BASE_DELAY_MS = 5_000;
  private static readonly MAX_DELAY_MS = 5 * 60_000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 50;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private static readonly COOLDOWN_FILE = path.join(
    DATA_DIR,
    'discord-session-cooldown.json',
  );

  /** Persist session-limit reset time so restarts don't burn sessions. */
  private static saveCooldown(resetAt: string): void {
    try {
      fs.mkdirSync(path.dirname(DiscordChannel.COOLDOWN_FILE), {
        recursive: true,
      });
      fs.writeFileSync(
        DiscordChannel.COOLDOWN_FILE,
        JSON.stringify({ resetAt }),
      );
    } catch {
      // Best-effort
    }
  }

  private static clearCooldown(): void {
    try {
      fs.unlinkSync(DiscordChannel.COOLDOWN_FILE);
    } catch {
      // File may not exist
    }
  }

  /** Returns ISO string if cooldown is still active, null otherwise. */
  private static getActiveCooldown(): string | null {
    try {
      const raw = fs.readFileSync(DiscordChannel.COOLDOWN_FILE, 'utf-8');
      const { resetAt } = JSON.parse(raw);
      if (resetAt && new Date(resetAt).getTime() > Date.now()) {
        return resetAt;
      }
      // Expired — clean up
      DiscordChannel.clearCooldown();
    } catch {
      // No file or invalid
    }
    return null;
  }

  private getBackoffDelay(): number {
    const delay =
      DiscordChannel.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    return Math.min(delay, DiscordChannel.MAX_DELAY_MS);
  }

  async connect(): Promise<void> {
    // Check persisted cooldown — skip login if session limit hasn't reset yet.
    const cooldown = DiscordChannel.getActiveCooldown();
    if (cooldown) {
      logger.info(
        { resetAt: cooldown },
        'Discord session limit still active (persisted cooldown) — deferring login',
      );
      console.log(
        `\n  Discord: session-limited until ${cooldown}, will auto-retry\n`,
      );
      this.scheduleReconnect(cooldown);
      return;
    }
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    // Track shard lifecycle to manage reconnection ourselves with backoff.
    // discord.js's internal reconnection can fire hundreds of times when
    // the network is down, burning through Discord's 1000-session daily limit.
    this.client.on(Events.ShardReady, (shardId) => {
      logger.info({ shardId }, 'Discord shard ready');
      this.reconnectAttempts = 0; // Reset backoff on successful connection
      this.manualReconnecting = false;
      DiscordChannel.clearCooldown();
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      logger.warn(
        { shardId, code: event.code, reason: event.reason },
        'Discord shard disconnected',
      );
      // Let discord.js handle clean disconnects (code 1000) and
      // resumable disconnects. For others, take over reconnection.
      if (event.code !== 1000 && event.code !== 4_000) {
        this.handleDisconnect();
      }
    });

    this.client.on(Events.ShardError, (err, shardId) => {
      logger.error({ shardId, err: err.message }, 'Discord shard error');
      this.handleDisconnect();
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err) => {
        // Session limit exceeded — Discord allows ~1000 session starts per 24h.
        // Log and resolve so other channels can still work; schedule a retry.
        const resetMatch = err.message?.match(/resets at (.+)/);
        const resetAt = resetMatch ? resetMatch[1] : null;
        logger.warn(
          { err: err.message, resetAt },
          'Discord login failed — will retry in background',
        );
        console.log(
          `\n  Discord: login failed, retrying after ${resetAt || 'backoff'}\n`,
        );
        // Persist cooldown so process restarts don't burn more sessions
        if (resetAt) {
          DiscordChannel.saveCooldown(resetAt);
        }
        // Destroy the broken client so isConnected() returns false
        // and sendMessage() won't try to use a client with no token.
        if (this.client) {
          try {
            this.client.destroy();
          } catch {
            // Already destroyed
          }
          this.client = null;
        }
        resolve(); // Don't block startup
        this.scheduleReconnect(resetAt);
      });
    });
  }

  /**
   * Destroy the client and reconnect with exponential backoff.
   * Prevents discord.js's internal reconnection from burning through
   * Discord's session limit during network outages.
   */
  private handleDisconnect(): void {
    if (this.manualReconnecting) return; // Already handling it
    this.manualReconnecting = true;

    // Destroy the client to stop discord.js's internal reconnection loop
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // Already destroyed
      }
      this.client = null;
    }

    this.scheduleReconnect(null);
  }

  private scheduleReconnect(resetAt: string | null): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.reconnectAttempts >= DiscordChannel.MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'Discord: max reconnect attempts reached — giving up. Restart NanoClaw to retry.',
      );
      return;
    }

    let delayMs: number;
    if (resetAt) {
      const resetTime = new Date(resetAt).getTime();
      if (!isNaN(resetTime)) {
        // Wait until reset + 30s buffer
        delayMs = Math.max(resetTime - Date.now() + 30_000, 60_000);
      } else {
        delayMs = this.getBackoffDelay();
      }
    } else {
      delayMs = this.getBackoffDelay();
    }

    this.reconnectAttempts++;
    logger.info(
      {
        delayMs,
        attempt: this.reconnectAttempts,
        retryAt: new Date(Date.now() + delayMs).toISOString(),
      },
      'Discord reconnect scheduled',
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        logger.info(
          { attempt: this.reconnectAttempts },
          'Discord: attempting reconnect',
        );
        await this.connect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, 'Discord reconnect failed');
        const match = msg.match(/resets at (.+)/);
        this.scheduleReconnect(match ? match[1] : null);
      }
    }, delayMs);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async react(
    chatJid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = chatJid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'messages' in channel) {
        const msg = await (channel as TextChannel).messages.fetch(messageId);
        await msg.react(emoji);
      }
    } catch (err) {
      logger.debug(
        { chatJid, messageId, err },
        'Failed to send Discord reaction',
      );
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
