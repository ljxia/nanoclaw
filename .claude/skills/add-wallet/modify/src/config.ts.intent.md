# Intent: Add WALLET_CONFIG_PATH

Add `WALLET_CONFIG_PATH` export pointing to `~/.config/nanoclaw/wallet.json`.
This follows the existing pattern of `SERVICES_CONFIG_PATH` and `MOUNT_ALLOWLIST_PATH` —
config stored outside project root, never mounted into containers.

Append-only change after the `SERVICES_CONFIG_PATH` definition.
