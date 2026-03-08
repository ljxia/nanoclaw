# Intent: Block wallet keys from container mounts

Add `'nanoclaw/keys'` to `DEFAULT_BLOCKED_PATTERNS` array.
This prevents the encrypted key files at `~/.config/nanoclaw/keys/` from
ever being mounted into a container, even if an allowlist rule would
otherwise permit it. Defense in depth.

Append-only change to the array.
