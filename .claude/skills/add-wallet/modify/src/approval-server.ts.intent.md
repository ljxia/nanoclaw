# Intent: Add wallet approval endpoint

1. Add `handleWalletApproval()` function before the HTTP server creation.
   Formats transaction/signing details as a Discord message with approve/deny reactions.
   Reuses existing `pendingApprovals` map and emoji constants.

2. Add `POST /wallet-approve` route to the HTTP server.
   Called by the host wallet service before signing.
   Returns `{ approved: boolean }`.

The endpoint follows the same pattern as `/request` (PreToolUse approval)
but with a wallet-specific message format showing recipient, amount, chain, and memo.
