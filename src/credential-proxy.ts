/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Supports runtime backend switching via /backend command.
 * Backends are configured in .env with BACKEND_<NAME>_URL/KEY/MODEL.
 * Claude is always available as the default backend.
 *
 * Claude auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { Transform, TransformCallback } from 'stream';
import fs from 'fs';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

// ── Backend config ─────────────────────────────────────────────────

interface BackendConfig {
  name: string;
  upstreamUrl: URL;
  isHttps: boolean;
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
  modelOverride?: string;
}

// ── Runtime backend state ──────────────────────────────────────────

let activeBackendName = 'claude';
const backends = new Map<string, BackendConfig>();

export function setBackend(name: string): boolean {
  if (!backends.has(name)) return false;
  const prev = activeBackendName;
  activeBackendName = name;
  logger.info({ backend: name }, 'Backend switched');
  if (prev !== name) emitSwitch(prev, name, 'manual');
  return true;
}

export function getBackend(): string {
  return activeBackendName;
}

export function getAvailableBackends(): string[] {
  return Array.from(backends.keys());
}

export function isBackendAvailable(name: string): boolean {
  return backends.has(name);
}

// ── Credential loading ─────────────────────────────────────────────

function loadClaudeConfig(): BackendConfig {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );

  return {
    name: 'claude',
    upstreamUrl,
    isHttps: upstreamUrl.protocol === 'https:',
    authMode,
    apiKey: secrets.ANTHROPIC_API_KEY,
    oauthToken,
  };
}

/**
 * Scan .env for BACKEND_<NAME>_URL / BACKEND_<NAME>_KEY / BACKEND_<NAME>_MODEL
 * entries and register each as a backend.
 */
function loadDynamicBackends(): void {
  // Read the raw .env file to discover BACKEND_* keys
  const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf-8') : '';

  const backendNames = new Set<string>();
  const pattern = /^BACKEND_([A-Z0-9_]+)_(URL|KEY|MODEL)\s*=/gm;
  let match;
  while ((match = pattern.exec(envFile)) !== null) {
    backendNames.add(match[1]);
  }

  for (const rawName of backendNames) {
    const keys = [
      `BACKEND_${rawName}_URL`,
      `BACKEND_${rawName}_KEY`,
      `BACKEND_${rawName}_MODEL`,
    ];
    const env = readEnvFile(keys);
    const url = process.env[keys[0]] || env[keys[0]];
    const key = process.env[keys[1]] || env[keys[1]];
    const model = process.env[keys[2]] || env[keys[2]];

    if (!url || !key) {
      logger.debug(
        { backend: rawName },
        'Backend missing URL or KEY, skipping',
      );
      continue;
    }

    const name = rawName.toLowerCase();
    const upstreamUrl = new URL(url);

    backends.set(name, {
      name,
      upstreamUrl,
      isHttps: upstreamUrl.protocol === 'https:',
      authMode: 'api-key',
      apiKey: key,
      modelOverride: model,
    });

    logger.info(
      { backend: name, url, model: model || '(default)' },
      'Backend registered',
    );
  }
}

// ── Failure tracking & auto-advance ────────────────────────────────

const RATE_LIMIT_CODES = new Set([429, 529]);
const ERROR_CODES = new Set([429, 500, 502, 503, 529]);
const MAX_CONSECUTIVE_FAILURES = 3;

/** Consecutive failure count per backend. Reset on success. */
const failureCount = new Map<string, number>();

function isRateLimited(statusCode: number): boolean {
  return RATE_LIMIT_CODES.has(statusCode);
}

// ── Token usage tracking ──────────────────────────────────────────

export interface UsageEntry {
  timestamp: string;
  backend: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  path: string;
}

/** Callback for external consumers (e.g. DB persistence). */
let usageCallback: ((entry: UsageEntry) => void) | null = null;

export function onUsage(cb: (entry: UsageEntry) => void): void {
  usageCallback = cb;
}

export interface BackendSwitchEvent {
  timestamp: string;
  from: string;
  to: string;
  reason:
    | 'manual'
    | 'rate-limited'
    | 'consecutive-failures'
    | 'connection-error';
}

let switchCallback: ((event: BackendSwitchEvent) => void) | null = null;

export function onBackendSwitch(cb: (event: BackendSwitchEvent) => void): void {
  switchCallback = cb;
}

function emitSwitch(
  from: string,
  to: string,
  reason: BackendSwitchEvent['reason'],
): void {
  if (switchCallback) {
    switchCallback({
      timestamp: new Date().toISOString(),
      from,
      to,
      reason,
    });
  }
}

/**
 * Transform stream that passes SSE data through unchanged while
 * extracting Anthropic usage fields from message_start and message_delta events.
 */
class UsageTapStream extends Transform {
  private buffer = '';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private model: string | null = null;
  private backend: string;
  private reqPath: string;

  constructor(backend: string, reqPath: string) {
    super();
    this.backend = backend;
    this.reqPath = reqPath;
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    // Pass data through immediately — zero latency impact
    this.push(chunk);

    // Accumulate for SSE line parsing
    this.buffer += chunk.toString();
    this.parseEvents();
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.parseEvents();
    this.emit('usage_complete');
    callback();
  }

  private parseEvents(): void {
    // Process complete SSE lines
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const event = JSON.parse(jsonStr);

        if (event.type === 'message_start' && event.message) {
          if (event.message.model) this.model = event.message.model;
          const u = event.message.usage;
          if (u) {
            this.inputTokens += u.input_tokens || 0;
            this.cacheReadTokens += u.cache_read_input_tokens || 0;
            this.cacheCreationTokens += u.cache_creation_input_tokens || 0;
          }
        }

        if (event.type === 'message_delta' && event.usage) {
          this.outputTokens += event.usage.output_tokens || 0;
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  getUsage(): UsageEntry {
    return {
      timestamp: new Date().toISOString(),
      backend: this.backend,
      model: this.model,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_tokens: this.cacheReadTokens,
      cache_creation_tokens: this.cacheCreationTokens,
      path: this.reqPath,
    };
  }
}

function recordFailure(backendName: string): number {
  const count = (failureCount.get(backendName) || 0) + 1;
  failureCount.set(backendName, count);
  return count;
}

function recordSuccess(backendName: string): void {
  failureCount.set(backendName, 0);
}

/**
 * Return the next backend to try after `current`, skipping backends
 * already in the `tried` set. Returns null if all have been tried.
 */
function nextFallback(current: string, tried: Set<string>): string | null {
  const names = Array.from(backends.keys());
  // Start after current, then wrap around
  const idx = names.indexOf(current);
  for (let i = 1; i < names.length; i++) {
    const candidate = names[(idx + i) % names.length];
    if (!tried.has(candidate)) return candidate;
  }
  return null;
}

// ── Shared request handler ─────────────────────────────────────────

function prepareBody(
  rawBody: Buffer,
  backend: BackendConfig,
  isAlternate: boolean,
): Buffer {
  if (!isAlternate || !backend.modelOverride || rawBody.length === 0) {
    return rawBody;
  }
  try {
    const json = JSON.parse(rawBody.toString());
    if (json.model && typeof json.model === 'string') {
      json.model = backend.modelOverride;
      return Buffer.from(JSON.stringify(json));
    }
  } catch {
    // Not valid JSON — pass through unchanged
  }
  return rawBody;
}

function createRequestHandler() {
  return (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);

      // OAuth exchange and auth probe requests always go to Claude
      const isAuthRequest = req.url?.includes('/oauth/') || false;
      if (isAuthRequest) {
        sendToBackend('claude', rawBody, req, res, isAuthRequest, new Set());
        return;
      }

      sendToBackend(activeBackendName, rawBody, req, res, false, new Set());
    });
  };
}

function sendToBackend(
  backendName: string,
  rawBody: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
  isAuthRequest: boolean,
  tried: Set<string>,
): void {
  tried.add(backendName);
  const backend = backends.get(backendName)!;
  const isAlternate = backendName !== 'claude' && !isAuthRequest;
  const body = prepareBody(rawBody, backend, isAlternate);

  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: backend.upstreamUrl.host,
    'content-length': body.length,
  };

  // Strip hop-by-hop headers
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];

  if (backend.authMode === 'api-key') {
    delete headers['x-api-key'];
    headers['x-api-key'] = backend.apiKey;
  } else {
    // OAuth mode (Claude only)
    if (headers['authorization']) {
      delete headers['authorization'];
      if (backend.oauthToken) {
        headers['authorization'] = `Bearer ${backend.oauthToken}`;
      }
    }
  }

  const basePath = backend.upstreamUrl.pathname.replace(/\/+$/, '');
  const upstreamPath = basePath ? basePath + req.url : req.url;

  const makeRequest = backend.isHttps ? httpsRequest : httpRequest;
  const upstream = makeRequest(
    {
      hostname: backend.upstreamUrl.hostname,
      port: backend.upstreamUrl.port || (backend.isHttps ? 443 : 80),
      path: upstreamPath,
      method: req.method,
      headers,
      family: 4, // Force IPv4
    } as RequestOptions,
    (upRes) => {
      const status = upRes.statusCode!;
      const shouldFailoverNow = isRateLimited(status);
      const isError = ERROR_CODES.has(status);

      if (isError && !isAuthRequest) {
        const failures = recordFailure(backendName);

        // Immediate failover on rate limit, or after 3 consecutive errors
        if (shouldFailoverNow || failures >= MAX_CONSECUTIVE_FAILURES) {
          // Drain the response body before trying next backend
          upRes.resume();

          const fallback = nextFallback(backendName, tried);
          if (fallback) {
            logger.warn(
              {
                from: backendName,
                to: fallback,
                status,
                failures,
                reason: shouldFailoverNow
                  ? 'rate-limited'
                  : 'consecutive-failures',
              },
              'Failing over to next backend',
            );
            activeBackendName = fallback;
            emitSwitch(
              backendName,
              fallback,
              shouldFailoverNow ? 'rate-limited' : 'consecutive-failures',
            );
            sendToBackend(fallback, rawBody, req, res, false, tried);
            return;
          }
          // All backends exhausted
          logger.error(
            { backend: backendName, tried: Array.from(tried) },
            'All backends exhausted',
          );
        }
      } else if (!isAuthRequest) {
        recordSuccess(backendName);
      }

      res.writeHead(status, upRes.headers);

      // Tap SSE streams to extract token usage without adding latency
      const contentType = upRes.headers['content-type'] || '';
      if (
        usageCallback &&
        !isAuthRequest &&
        status === 200 &&
        contentType.includes('text/event-stream')
      ) {
        const tap = new UsageTapStream(backendName, req.url || '');
        tap.on('usage_complete', () => {
          const usage = tap.getUsage();
          if (usage.input_tokens > 0 || usage.output_tokens > 0) {
            usageCallback!(usage);
          }
        });
        upRes.pipe(tap).pipe(res);
      } else {
        upRes.pipe(res);
      }
    },
  );

  upstream.on('error', (err) => {
    logger.error(
      { err, url: req.url, backend: backendName },
      'Credential proxy upstream error',
    );
    // Try next backend on connection errors too
    const fallback = nextFallback(backendName, tried);
    if (fallback && !isAuthRequest) {
      logger.warn(
        { from: backendName, to: fallback },
        'Connection error — failing over to next backend',
      );
      activeBackendName = fallback;
      emitSwitch(backendName, fallback, 'connection-error');
      sendToBackend(fallback, rawBody, req, res, false, tried);
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

// ── Initialization ─────────────────────────────────────────────────

function initBackends(): void {
  if (backends.size > 0) return; // Already initialized

  // Claude is always available
  const claude = loadClaudeConfig();
  backends.set('claude', claude);

  // Load BACKEND_* entries from .env
  loadDynamicBackends();

  const names = getAvailableBackends();
  if (names.length > 1) {
    logger.info(
      { backends: names },
      'Multiple backends available — use /backend to switch',
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  initBackends();
  const claude = backends.get('claude')!;

  return new Promise((resolve, reject) => {
    const server = createServer(createRequestHandler());

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode: claude.authMode },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/**
 * Start the credential proxy on a Unix socket.
 * Used for rootless Docker where TCP-based host networking doesn't work.
 */
export function startCredentialProxySocket(
  socketPath: string,
): Promise<Server> {
  // Clean up stale socket from previous run
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* doesn't exist */
  }

  initBackends();
  const claude = backends.get('claude')!;

  return new Promise((resolve, reject) => {
    const server = createServer(createRequestHandler());

    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o666);
      logger.info(
        { socketPath, authMode: claude.authMode },
        'Credential proxy started (Unix socket)',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
