/**
 * Wallet Signing Oracle for NanoClaw
 *
 * The private key NEVER leaves this module. Container agents request
 * operations via IPC; this service signs after human approval.
 *
 * Key storage: encrypted file at ~/.config/nanoclaw/keys/<wallet>.enc
 * Config: ~/.config/nanoclaw/wallet.json
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionRequest,
  type WalletClient,
} from 'viem';
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  sepolia,
} from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { WALLET_CONFIG_PATH } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletConfig {
  wallets: Record<string, WalletEntry>;
  limits: SpendingLimits;
  rpcEndpoints: Record<string, string>;
  trustedRecipients?: string[];
}

interface WalletEntry {
  address: string;
  encryptedKeyPath: string;
  chains: string[];
}

export interface SpendingLimits {
  perTransactionUsd: number;
  dailyUsd: number;
  cooldownMs: number;
  ratePerHour: number;
}

export interface WalletTxRecord {
  id: string;
  walletName: string;
  chain: string;
  toAddress: string;
  valueWei: string;
  valueUsd: number | null;
  txHash: string | null;
  status: string;
  requestedBy: string;
  requestedAt: string;
  approvedAt: string | null;
  memo: string | null;
}

export interface SendTransactionRequest {
  walletName: string;
  chain: string;
  to: string;
  value: string; // human-readable (e.g. "0.5")
  token?: string; // ERC-20 contract address
  memo?: string;
  requestId: string;
  sourceGroup: string;
}

export interface SignMessageRequest {
  walletName: string;
  message: string;
  memo?: string;
  requestId: string;
  sourceGroup: string;
}

// ---------------------------------------------------------------------------
// Chain registry
// ---------------------------------------------------------------------------

const CHAIN_MAP: Record<string, Chain> = {
  ethereum: mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  sepolia,
};

// Minimal ERC-20 ABI for transfer and balanceOf
const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    name: 'symbol',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const TAG_LEN = 16;
const ITERATIONS = 100_000;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha512');
}

export function encryptPrivateKey(
  privateKey: string,
  password: string,
): Buffer {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKey, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: salt || iv || tag || ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]);
}

function decryptPrivateKey(data: Buffer, password: string): string {
  const salt = data.subarray(0, SALT_LEN);
  const iv = data.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = data.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const encrypted = data.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

// ---------------------------------------------------------------------------
// WalletService
// ---------------------------------------------------------------------------

export class WalletService {
  private config: WalletConfig;
  private decryptedKeys = new Map<string, Hex>();
  private publicClients = new Map<string, PublicClient>();
  private txLog: WalletTxRecord[] = [];
  private lastTxTime = new Map<string, number>(); // group -> timestamp
  private unlockPassword: string | null = null;

  constructor(config: WalletConfig) {
    this.config = config;
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Load and decrypt wallet keys at startup.
   * Prompts for password on stdin if running interactively.
   */
  async unlock(password?: string): Promise<void> {
    for (const [name, entry] of Object.entries(this.config.wallets)) {
      const keyPath = expandHome(entry.encryptedKeyPath);
      if (!fs.existsSync(keyPath)) {
        logger.warn(
          { wallet: name, keyPath },
          'Encrypted key file not found — skipping',
        );
        continue;
      }

      const pwd =
        password ??
        (await promptPassword(`Enter password for wallet "${name}": `));
      this.unlockPassword = pwd;
      try {
        const data = fs.readFileSync(keyPath);
        const pk = decryptPrivateKey(data, pwd) as Hex;
        // Validate the key produces the expected address
        const account = privateKeyToAccount(pk);
        if (account.address.toLowerCase() !== entry.address.toLowerCase()) {
          throw new Error(
            `Address mismatch: key decrypts to ${account.address}, expected ${entry.address}`,
          );
        }
        this.decryptedKeys.set(name, pk);
        logger.info(
          { wallet: name, address: entry.address },
          'Wallet unlocked',
        );
      } catch (err) {
        logger.error({ wallet: name, err }, 'Failed to unlock wallet');
        throw err;
      }
    }
  }

  isUnlocked(walletName: string): boolean {
    return this.decryptedKeys.has(walletName);
  }

  /**
   * Create a new wallet with a random private key.
   * The key is generated on the host, encrypted, and stored — the agent
   * only receives the address. Returns the address or an error.
   */
  createWallet(
    name: string,
    chains?: string[],
  ): { address: string; chains: string[] } | { error: string } {
    // Validate name
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      return {
        error:
          'Wallet name must be 1-32 alphanumeric/dash/underscore characters',
      };
    }
    if (this.config.wallets[name]) {
      return { error: `Wallet "${name}" already exists` };
    }
    if (!this.unlockPassword) {
      return {
        error: 'No encryption password available — unlock a wallet first',
      };
    }

    // Generate random private key
    const randomBytes = crypto.randomBytes(32);
    const privateKey = `0x${randomBytes.toString('hex')}` as Hex;
    const account = privateKeyToAccount(privateKey);

    // Encrypt and save
    const keysDir = path.join(os.homedir(), '.config', 'nanoclaw', 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    const keyPath = path.join(keysDir, `${name}.enc`);
    const encrypted = encryptPrivateKey(privateKey, this.unlockPassword);
    fs.writeFileSync(keyPath, encrypted);
    fs.chmodSync(keyPath, 0o600);

    // Use the chains from the first configured wallet as default, or the provided list
    const effectiveChains = chains ??
      Object.values(this.config.wallets)[0]?.chains ?? ['ethereum'];

    // Register in config
    const entry: WalletEntry = {
      address: account.address,
      encryptedKeyPath: `~/.config/nanoclaw/keys/${name}.enc`,
      chains: effectiveChains,
    };
    this.config.wallets[name] = entry;
    this.decryptedKeys.set(name, privateKey);

    // Persist to wallet.json
    try {
      fs.writeFileSync(
        WALLET_CONFIG_PATH,
        JSON.stringify(this.config, null, 2) + '\n',
      );
    } catch (err) {
      logger.warn(
        { err },
        'Failed to persist wallet config — wallet works in memory but may not survive restart',
      );
    }

    logger.info(
      { wallet: name, address: account.address, chains: effectiveChains },
      'Created new wallet',
    );

    return { address: account.address, chains: effectiveChains };
  }

  // -- Read-only operations -------------------------------------------------

  getAddress(walletName: string): string | null {
    const entry = this.config.wallets[walletName];
    return entry?.address ?? null;
  }

  getSupportedChains(walletName: string): string[] {
    const entry = this.config.wallets[walletName];
    return entry?.chains ?? [];
  }

  getWalletNames(): string[] {
    return Object.keys(this.config.wallets);
  }

  async getBalance(
    walletName: string,
    chain: string,
    token?: string,
  ): Promise<{ balance: string; symbol: string; decimals: number }> {
    const entry = this.config.wallets[walletName];
    if (!entry) throw new Error(`Unknown wallet: ${walletName}`);
    if (!entry.chains.includes(chain)) {
      throw new Error(
        `Wallet "${walletName}" not configured for chain "${chain}"`,
      );
    }

    const client = this.getPublicClient(chain);
    const address = entry.address as Address;

    if (!token) {
      const bal = await client.getBalance({ address });
      return { balance: formatEther(bal), symbol: 'ETH', decimals: 18 };
    }

    // ERC-20
    const tokenAddr = token as Address;
    const [rawBal, decimals, symbol] = await Promise.all([
      client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }) as Promise<bigint>,
      client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }) as Promise<number>,
      client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }) as Promise<string>,
    ]);

    return {
      balance: formatUnits(rawBal, decimals),
      symbol,
      decimals,
    };
  }

  async estimateGas(
    chain: string,
    to: string,
    value: string,
    token?: string,
  ): Promise<{ gasEstimate: string; gasCostEth: string }> {
    const client = this.getPublicClient(chain);
    const toAddr = to as Address;

    let gas: bigint;
    if (!token) {
      gas = await client.estimateGas({
        to: toAddr,
        value: parseEther(value),
      });
    } else {
      gas = await client.estimateGas({
        to: token as Address,
        data: '0x' as Hex, // placeholder
      });
    }

    const gasPrice = await client.getGasPrice();
    const gasCost = gas * gasPrice;

    return {
      gasEstimate: gas.toString(),
      gasCostEth: formatEther(gasCost),
    };
  }

  // -- Signing operations ---------------------------------------------------

  async sendTransaction(
    req: SendTransactionRequest,
  ): Promise<{ txHash: string } | { error: string }> {
    // Validate wallet
    const pk = this.decryptedKeys.get(req.walletName);
    if (!pk) return { error: `Wallet "${req.walletName}" not unlocked` };

    const entry = this.config.wallets[req.walletName];
    if (!entry.chains.includes(req.chain)) {
      return { error: `Wallet not configured for chain "${req.chain}"` };
    }

    // Check spending limits
    const limitCheck = this.checkLimits(req.sourceGroup, req.value, req.chain);
    if (limitCheck) return { error: limitCheck };

    const chain = CHAIN_MAP[req.chain];
    if (!chain) return { error: `Unknown chain: ${req.chain}` };

    const account = privateKeyToAccount(pk);
    const rpcUrl = this.config.rpcEndpoints[req.chain];
    if (!rpcUrl) return { error: `No RPC endpoint for chain "${req.chain}"` };

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    try {
      let txHash: Hex;
      if (!req.token) {
        // Native ETH transfer
        txHash = await walletClient.sendTransaction({
          to: req.to as Address,
          value: parseEther(req.value),
        });
      } else {
        // ERC-20 transfer
        const client = this.getPublicClient(req.chain);
        const decimals = (await client.readContract({
          address: req.token as Address,
          abi: ERC20_ABI,
          functionName: 'decimals',
        })) as number;

        txHash = await walletClient.writeContract({
          address: req.token as Address,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [req.to as Address, parseUnits(req.value, decimals)],
        });
      }

      // Record transaction
      this.recordTx({
        id: req.requestId,
        walletName: req.walletName,
        chain: req.chain,
        toAddress: req.to,
        valueWei: parseEther(req.value).toString(),
        valueUsd: null,
        txHash,
        status: 'submitted',
        requestedBy: req.sourceGroup,
        requestedAt: new Date().toISOString(),
        approvedAt: new Date().toISOString(),
        memo: req.memo ?? null,
      });

      this.lastTxTime.set(req.sourceGroup, Date.now());
      return { txHash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Transaction failed: ${msg}` };
    }
  }

  async signMessage(
    req: SignMessageRequest,
  ): Promise<{ signature: string } | { error: string }> {
    const pk = this.decryptedKeys.get(req.walletName);
    if (!pk) return { error: `Wallet "${req.walletName}" not unlocked` };

    const account = privateKeyToAccount(pk);
    try {
      const signature = await account.signMessage({ message: req.message });
      return { signature };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Signing failed: ${msg}` };
    }
  }

  // -- Spending limits ------------------------------------------------------

  private checkLimits(
    sourceGroup: string,
    value: string,
    chain: string,
  ): string | null {
    const limits = this.config.limits;

    // Cooldown
    const lastTx = this.lastTxTime.get(sourceGroup);
    if (lastTx && Date.now() - lastTx < limits.cooldownMs) {
      const waitSec = Math.ceil(
        (limits.cooldownMs - (Date.now() - lastTx)) / 1000,
      );
      return `Cooldown active — wait ${waitSec}s before next transaction`;
    }

    // Rate limit (txs per hour per group)
    const oneHourAgo = Date.now() - 3_600_000;
    const recentCount = this.txLog.filter(
      (tx) =>
        tx.requestedBy === sourceGroup &&
        new Date(tx.requestedAt).getTime() > oneHourAgo,
    ).length;
    if (recentCount >= limits.ratePerHour) {
      return `Rate limit: max ${limits.ratePerHour} transactions per hour`;
    }

    // Note: USD-based limits require a price oracle.
    // For now, we enforce per-tx and daily limits in native units only.
    // A price oracle integration can be added in a later phase.

    return null;
  }

  private recordTx(record: WalletTxRecord): void {
    this.txLog.push(record);
    // Keep last 1000 records in memory
    if (this.txLog.length > 1000) {
      this.txLog = this.txLog.slice(-500);
    }
  }

  getTransactionLog(sourceGroup?: string): WalletTxRecord[] {
    if (sourceGroup) {
      return this.txLog.filter((tx) => tx.requestedBy === sourceGroup);
    }
    return [...this.txLog];
  }

  // -- Internal helpers -----------------------------------------------------

  private getPublicClient(chain: string): PublicClient {
    let client = this.publicClients.get(chain);
    if (client) return client;

    const chainDef = CHAIN_MAP[chain];
    if (!chainDef) throw new Error(`Unknown chain: ${chain}`);

    const rpcUrl = this.config.rpcEndpoints[chain];
    if (!rpcUrl) throw new Error(`No RPC endpoint for chain "${chain}"`);

    client = createPublicClient({ chain: chainDef, transport: http(rpcUrl) });
    this.publicClients.set(chain, client);
    return client;
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadWalletConfig(): WalletConfig | null {
  try {
    if (!fs.existsSync(WALLET_CONFIG_PATH)) {
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(WALLET_CONFIG_PATH, 'utf-8'));

    // Validate required fields
    if (!raw.wallets || typeof raw.wallets !== 'object') {
      throw new Error('wallet.json: "wallets" must be an object');
    }
    if (!raw.limits || typeof raw.limits !== 'object') {
      throw new Error('wallet.json: "limits" must be an object');
    }
    if (!raw.rpcEndpoints || typeof raw.rpcEndpoints !== 'object') {
      throw new Error('wallet.json: "rpcEndpoints" must be an object');
    }

    return {
      wallets: raw.wallets,
      limits: {
        perTransactionUsd: raw.limits.perTransactionUsd ?? 100,
        dailyUsd: raw.limits.dailyUsd ?? 500,
        cooldownMs: raw.limits.cooldownMs ?? 30_000,
        ratePerHour: raw.limits.ratePerHour ?? 10,
      },
      rpcEndpoints: raw.rpcEndpoints,
      trustedRecipients: raw.trustedRecipients,
    };
  } catch (err) {
    logger.error(
      { err, path: WALLET_CONFIG_PATH },
      'Failed to load wallet config',
    );
    return null;
  }
}

/**
 * Generate a wallet.json template for users to customize.
 */
export function generateWalletConfigTemplate(): string {
  return JSON.stringify(
    {
      wallets: {
        main: {
          address: '0xYOUR_ADDRESS_HERE',
          encryptedKeyPath: '~/.config/nanoclaw/keys/main.enc',
          chains: ['ethereum', 'base', 'arbitrum'],
        },
      },
      limits: {
        perTransactionUsd: 100,
        dailyUsd: 500,
        cooldownMs: 30000,
        ratePerHour: 10,
      },
      rpcEndpoints: {
        ethereum: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY',
        base: 'https://base-mainnet.g.alchemy.com/v2/YOUR_KEY',
        arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY',
      },
      trustedRecipients: [],
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// CLI: encrypt a private key (run standalone)
// ---------------------------------------------------------------------------

export async function encryptKeyInteractive(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  try {
    const walletName = await ask('Wallet name (e.g. "main"): ');
    const privateKey = await ask('Private key (0x...): ');
    const password = await ask('Encryption password: ');
    const confirm = await ask('Confirm password: ');

    if (password !== confirm) {
      console.error('Passwords do not match');
      process.exit(1);
    }

    // Validate the key
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const account = privateKeyToAccount(pk as Hex);
    console.error(`Address: ${account.address}`);

    const encrypted = encryptPrivateKey(pk, password);
    const keysDir = path.join(os.homedir(), '.config', 'nanoclaw', 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    const outPath = path.join(keysDir, `${walletName}.enc`);
    fs.writeFileSync(outPath, encrypted);
    fs.chmodSync(outPath, 0o600);

    console.error(`Encrypted key saved to: ${outPath}`);
    console.error(`Address: ${account.address}`);
    console.error(`\nAdd this to wallet.json:`);
    console.error(
      JSON.stringify(
        {
          [walletName]: {
            address: account.address,
            encryptedKeyPath: `~/.config/nanoclaw/keys/${walletName}.enc`,
            chains: ['ethereum'],
          },
        },
        null,
        2,
      ),
    );
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

async function promptPassword(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
