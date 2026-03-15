/**
 * Lightweight dashboard HTTP server with SSE for real-time agent progress.
 * Serves a single-page HTML dashboard and streams events.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { dashboardBus, DashboardEventMap } from './dashboard-events.js';
import { QueueSnapshot } from './group-queue.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let getQueueState: () => QueueSnapshot = () => ({
  activeCount: 0,
  maxConcurrent: 1,
  activeGroups: [],
  waitingCount: 0,
});

const clients = new Set<http.ServerResponse>();
// Per-agent stream clients: group name -> set of SSE responses
const agentClients = new Map<string, Set<http.ServerResponse>>();

function broadcast(eventType: string, data: unknown): void {
  const payload = `data: ${JSON.stringify({ type: eventType, ...(data as Record<string, unknown>) })}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function broadcastToAgent(
  group: string,
  eventType: string,
  data: unknown,
): void {
  const groupClients = agentClients.get(group);
  if (!groupClients || groupClients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: eventType, ...(data as Record<string, unknown>) })}\n\n`;
  for (const client of groupClients) {
    client.write(payload);
  }
}

// Subscribe to all dashboard events and broadcast to SSE clients
for (const eventName of [
  'container:start',
  'container:end',
  'agent:phase',
  'queue:update',
] as ('container:start' | 'container:end' | 'agent:phase' | 'queue:update')[]) {
  dashboardBus.onEvent(eventName, (data) => {
    broadcast(eventName, data as unknown as Record<string, unknown>);
    // Also forward phase/lifecycle events to per-agent streams
    const d = data as unknown as Record<string, unknown>;
    if ('group' in d) {
      broadcastToAgent(d.group as string, eventName, d);
    }
  });
}

// Stream events go only to per-agent clients
dashboardBus.onEvent('agent:stream', (data) => {
  broadcastToAgent(data.group, 'agent:stream', data);
});

function serveDashboardHtml(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Try loading from src/ first (dev), then dist/ (built)
  const candidates = [
    path.join(__dirname, '..', 'src', 'dashboard.html'),
    path.join(__dirname, 'dashboard.html'),
    path.join(__dirname, '..', 'dashboard.html'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(candidate).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Dashboard HTML not found');
}

function serveSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send current state immediately
  const state = getQueueState();
  res.write(`data: ${JSON.stringify({ type: 'queue:update', ...state })}\n\n`);

  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function serveAgentSSE(
  group: string,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  if (!agentClients.has(group)) {
    agentClients.set(group, new Set());
  }
  agentClients.get(group)!.add(res);
  res.on('close', () => {
    const set = agentClients.get(group);
    if (set) {
      set.delete(res);
      if (set.size === 0) agentClients.delete(group);
    }
  });
}

function serveState(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const state = getQueueState();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(state));
}

export async function startDashboardServer(
  port: number,
  queueStateFn: () => QueueSnapshot,
): Promise<http.Server> {
  getQueueState = queueStateFn;

  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/events') return serveSSE(req, res);
    if (url === '/state') return serveState(req, res);
    if (url === '/' || url === '/index.html')
      return serveDashboardHtml(req, res);

    // Per-agent stream: /agent-stream/<group-name>
    const agentStreamMatch = url.match(/^\/agent-stream\/(.+)$/);
    if (agentStreamMatch) {
      return serveAgentSSE(decodeURIComponent(agentStreamMatch[1]), req, res);
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'Dashboard server started on port ' + port);
      resolve(server);
    });
  });
}
