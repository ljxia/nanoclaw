# Add Wallet Signing Oracle

Adds a secure crypto wallet integration where container agents can request wallet operations (check balance, send transactions, sign messages) without ever accessing the private key.

## Architecture

```
Container Agent                    Host Process
┌──────────────┐    IPC files     ┌─────────────────┐
│ MCP tools:   │ ──────────────▶ │ WalletService    │
│ wallet_*     │                  │ (holds key)      │
│              │ ◀────────────── │                  │
│ Never sees   │   result via    │ Signs after      │
│ private key  │   IPC input     │ Discord approval │
└──────────────┘                  └─────────────────┘
```

**Key never leaves the host.** The agent only sees addresses, balances, and tx hashes.

## Setup Steps

### 1. Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-wallet && npm run build
```

### 2. Create wallet config

```bash
mkdir -p ~/.config/nanoclaw/keys
```

Create `~/.config/nanoclaw/wallet.json`:

```json
{
  "wallets": {
    "main": {
      "address": "0xYOUR_ADDRESS",
      "encryptedKeyPath": "~/.config/nanoclaw/keys/main.enc",
      "chains": ["ethereum", "base", "arbitrum"]
    }
  },
  "limits": {
    "perTransactionUsd": 100,
    "dailyUsd": 500,
    "cooldownMs": 30000,
    "ratePerHour": 10
  },
  "rpcEndpoints": {
    "ethereum": "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
    "base": "https://base-mainnet.g.alchemy.com/v2/YOUR_KEY",
    "arbitrum": "https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY"
  },
  "trustedRecipients": []
}
```

### 3. Encrypt your private key

```bash
npx tsx -e "import { encryptKeyInteractive } from './src/wallet-service.js'; encryptKeyInteractive();"
```

This prompts for:
- Wallet name (e.g. "main")
- Private key (0x...)
- Encryption password

The encrypted key is saved to `~/.config/nanoclaw/keys/<name>.enc` (chmod 600).

**IMPORTANT:** The private key is only in memory during encryption. Delete any plaintext copies immediately.

### 4. Rebuild the container

```bash
./container/build.sh
```

### 5. Wire up in index.ts (manual step)

Add wallet service initialization to `src/index.ts` startup:

```typescript
import { loadWalletConfig, WalletService } from './wallet-service.js';

// In startup function:
const walletConfig = loadWalletConfig();
let walletService: WalletService | undefined;
if (walletConfig) {
  walletService = new WalletService(walletConfig);
  await walletService.unlock(); // prompts for password
}

// Pass to IPC deps:
const ipcDeps = {
  // ...existing deps...
  walletService,
  requestWalletApproval: async (details) => {
    // POST to approval server
    const res = await fetch('http://127.0.0.1:7711/wallet-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details),
    });
    const { approved } = await res.json();
    return approved;
  },
};
```

## MCP Tools Available to Agents

| Tool | Approval | Description |
|------|----------|-------------|
| `wallet_get_address` | None | Get wallet address and supported chains |
| `wallet_get_balance` | None | Check balance (native or ERC-20) |
| `wallet_estimate_gas` | None | Estimate gas cost before sending |
| `wallet_send_transaction` | **Required** | Send ETH or tokens (main group only) |
| `wallet_sign_message` | **Required** | Sign arbitrary message (main group only) |
| `wallet_tx_history` | None | View recent transaction log |

## Security Model

### What the agent CAN do
- Check balances and addresses (read-only, no approval)
- Request transactions (requires human approval via Discord)
- View transaction history

### What the agent CANNOT do
- Access the private key (never leaves host process memory)
- Bypass spending limits (enforced on host)
- Send transactions without Discord approval
- Execute arbitrary contract calls (only `transfer` is exposed)
- Call `approve()` on ERC-20 tokens (not exposed)
- Operate from non-main groups (signing operations blocked)

### Spending limits
- **Per-transaction cap** (default $100 USD)
- **Daily rolling limit** (default $500 USD)
- **Cooldown** between transactions (default 30s)
- **Rate limit** per hour per group (default 10)

### Attack surface mitigations
| Vector | Mitigation |
|--------|-----------|
| Many small transactions | Daily cap + rate limit + cooldown |
| Spoof recipient | Discord approval shows actual `to` address |
| Arbitrary contract calls | Only `transfer` exposed, not raw `data` |
| ERC-20 approve/permit | Not available as MCP tool |
| Read key from container | Key never mounted; `nanoclaw/keys` in blocked patterns |
| Non-main group signing | Blocked at IPC handler level |

## Gotchas

1. **Password prompt at startup**: The wallet service prompts for the encryption password on stdin. For unattended operation, pass it via environment variable or use the `unlock(password)` API.

2. **RPC endpoints required**: You need Alchemy/Infura/etc. API keys for each chain. Free tiers work for low volume.

3. **USD limits not enforced yet**: The spending limits are defined in USD but a price oracle is not integrated. Currently, rate limits and cooldowns are enforced. USD-based limits will need a CoinGecko/similar integration.

4. **Container rebuild required**: After applying the skill, you must rebuild the container image (`./container/build.sh`) for the new MCP tools to be available to agents.

5. **Approval server must be running**: Transaction/signing approval goes through the Discord approval server at port 7711. If it's down, transactions will fail (not silently approve).

6. **Transaction results go to agent via IPC input**, not to the user chat. The agent decides how to communicate the result.
