# Intent: Add wallet IPC handlers

1. Import `WalletService` from `./wallet-service.js`
2. Add `walletService?` and `requestWalletApproval?` to `IpcDeps` interface
3. Add case branches in `processTaskIpc()` for:
   - `wallet_get_address` — read-only, returns address and chains
   - `wallet_get_balance` — read-only, returns balance
   - `wallet_estimate_gas` — read-only, returns gas estimate
   - `wallet_send_transaction` — main-only, requires approval
   - `wallet_sign_message` — main-only, requires approval
   - `wallet_tx_history` — read-only, returns log

All wallet handlers go before the `default:` case. Results sent via `writeIpcInput()`.
Authorization: signing operations restricted to `isMain` groups.
