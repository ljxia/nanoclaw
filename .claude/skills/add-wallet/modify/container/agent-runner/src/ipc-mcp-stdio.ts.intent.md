# Intent: Add wallet MCP tools

Add 6 wallet tools before the stdio transport setup, following the existing
`writeIpcFile(TASKS_DIR, data)` pattern:

- `wallet_get_address` — read-only
- `wallet_get_balance` — read-only
- `wallet_estimate_gas` — read-only
- `wallet_send_transaction` — requires approval (documented in description)
- `wallet_sign_message` — requires approval (documented in description)
- `wallet_tx_history` — read-only

All tools use the same IPC pattern as `deploy_service`/`restart_service`:
write a JSON task file, return acknowledgment, result arrives via IPC input.
Each generates a unique `requestId` for response correlation.
