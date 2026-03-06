import crypto from 'crypto';
import http from 'http';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const env = readEnvFile([
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_WEBHOOK_PORT',
]);

const LINE_CHANNEL_SECRET =
  process.env.LINE_CHANNEL_SECRET || env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_WEBHOOK_PORT = parseInt(
  process.env.LINE_WEBHOOK_PORT || env.LINE_WEBHOOK_PORT || '3100',
  10,
);

const LINE_API_BASE = 'https://api.line.me/v2/bot';

interface LineEvent {
  type: string;
  replyToken?: string;
  source?: {
    type: string; // 'user' | 'group' | 'room'
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
  message?: {
    id: string;
    type: string;
    text?: string;
  };
}

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

function lineJid(source: LineEvent['source']): string | null {
  if (!source) return null;
  if (source.groupId) return `${source.groupId}@line.group`;
  if (source.roomId) return `${source.roomId}@line.room`;
  if (source.userId) return `${source.userId}@line.user`;
  return null;
}

function validateSignature(body: Buffer, signature: string): boolean {
  const hmac = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET);
  hmac.update(body);
  const digest = hmac.digest('base64');
  const digestBuf = Buffer.from(digest);
  const sigBuf = Buffer.from(signature);
  if (digestBuf.length !== sigBuf.length) {
    logger.debug(
      { digestLen: digestBuf.length, sigLen: sigBuf.length },
      'LINE signature length mismatch',
    );
    return false;
  }
  return crypto.timingSafeEqual(digestBuf, sigBuf);
}

async function lineApiFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${LINE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

export class LineChannel implements Channel {
  name = 'line';

  private server!: http.Server;
  private connected = false;
  private botUserId = '';
  private profileCache = new Map<string, string>();
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Verify credentials by fetching bot profile
    try {
      const res = await lineApiFetch('/info');
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LINE API error ${res.status}: ${text}`);
      }
      const info = (await res.json()) as {
        userId: string;
        displayName: string;
      };
      this.botUserId = info.userId;
      logger.info(
        { botName: info.displayName, botId: info.userId },
        'LINE bot authenticated',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to authenticate with LINE API');
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/webhook') {
          this.handleWebhook(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'LINE webhook server error');
        if (!this.connected) reject(err);
      });

      this.server.listen(LINE_WEBHOOK_PORT, () => {
        this.connected = true;
        logger.info(
          { port: LINE_WEBHOOK_PORT },
          'LINE webhook server listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    const id = jid.split('@')[0];

    // Determine push target type from JID suffix
    const body = JSON.stringify({
      to: id,
      messages: [{ type: 'text', text: prefixed }],
    });

    try {
      const res = await lineApiFetch('/message/push', {
        method: 'POST',
        body,
      });
      if (!res.ok) {
        const errText = await res.text();
        logger.error(
          { jid, status: res.status, error: errText },
          'Failed to send LINE message',
        );
      } else {
        logger.info({ jid, length: prefixed.length }, 'LINE message sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'LINE send error');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return (
      jid.endsWith('@line.group') ||
      jid.endsWith('@line.room') ||
      jid.endsWith('@line.user')
    );
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async syncGroups(): Promise<void> {
    // LINE doesn't have a list-groups API. Group names are fetched on message receipt.
  }

  private handleWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Validate signature
      const signature = req.headers['x-line-signature'] as string;
      if (!signature || !validateSignature(body, signature)) {
        logger.warn('Invalid LINE webhook signature');
        res.writeHead(401);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end();

      // Process events async
      this.processEvents(body).catch((err) =>
        logger.error({ err }, 'Error processing LINE events'),
      );
    });
  }

  private async processEvents(body: Buffer): Promise<void> {
    const data: LineWebhookBody = JSON.parse(body.toString());

    if (!data.events || data.events.length === 0) {
      logger.debug('LINE webhook: no events (verification ping)');
      return;
    }

    for (const event of data.events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;
      if (!event.message.text || !event.source) continue;

      const jid = lineJid(event.source);
      if (!jid) continue;

      const timestamp = new Date(event.timestamp).toISOString();
      const isGroup =
        event.source.type === 'group' || event.source.type === 'room';
      const senderId = event.source.userId || '';
      const senderName = await this.getDisplayName(senderId, event.source);
      const fromMe = senderId === this.botUserId;

      // Update group name if possible
      if (isGroup && event.source.groupId) {
        await this.syncGroupName(event.source.groupId);
      }

      // Notify metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'line', isGroup);

      // Only deliver to registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) continue;

      this.opts.onMessage(jid, {
        id: event.message.id,
        chat_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content: event.message.text,
        timestamp,
        is_from_me: fromMe,
        is_bot_message: fromMe,
      });
    }
  }

  private async getDisplayName(
    userId: string,
    source: LineEvent['source'],
  ): Promise<string> {
    if (!userId) return 'Unknown';

    const cached = this.profileCache.get(userId);
    if (cached) return cached;

    try {
      let res: Response;
      if (source?.groupId) {
        res = await lineApiFetch(`/group/${source.groupId}/member/${userId}`);
      } else if (source?.roomId) {
        res = await lineApiFetch(`/room/${source.roomId}/member/${userId}`);
      } else {
        res = await lineApiFetch(`/profile/${userId}`);
      }

      if (res.ok) {
        const profile = (await res.json()) as { displayName: string };
        this.profileCache.set(userId, profile.displayName);
        return profile.displayName;
      }
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to fetch LINE profile');
    }

    return userId.slice(0, 8);
  }

  private async syncGroupName(groupId: string): Promise<void> {
    try {
      const res = await lineApiFetch(`/group/${groupId}/summary`);
      if (res.ok) {
        const summary = (await res.json()) as { groupName: string };
        if (summary.groupName) {
          updateChatName(`${groupId}@line.group`, summary.groupName);
        }
      }
    } catch (err) {
      logger.debug({ groupId, err }, 'Failed to fetch LINE group summary');
    }
  }
}

registerChannel('line', (opts: ChannelOpts) => {
  if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
    return null;
  }
  return new LineChannel(opts);
});
