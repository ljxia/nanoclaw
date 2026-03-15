#!/bin/bash
set -e

# Bridge credential proxy Unix socket to localhost TCP so the Anthropic SDK
# can reach the host's credential proxy.
if [ -n "$CREDENTIAL_PROXY_SOCKET" ] && [ -S "$CREDENTIAL_PROXY_SOCKET" ]; then
  node -e "
    const net = require('net');
    const server = net.createServer(client => {
      const upstream = net.createConnection(process.env.CREDENTIAL_PROXY_SOCKET);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    server.listen(parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001'), '127.0.0.1');
  " &
fi

# Bridge allowed host port sockets to localhost TCP.
# NANOCLAW_HOST_PORTS format: "3000:/tmp/port-sockets/3000.sock,8080:/tmp/port-sockets/8080.sock"
if [ -n "$NANOCLAW_HOST_PORTS" ]; then
  IFS=',' read -ra PORT_ENTRIES <<< "$NANOCLAW_HOST_PORTS"
  for entry in "${PORT_ENTRIES[@]}"; do
    port="${entry%%:*}"
    socket="${entry#*:}"
    if [ -S "$socket" ]; then
      node -e "
        const net = require('net');
        const server = net.createServer(client => {
          const upstream = net.createConnection('$socket');
          client.pipe(upstream);
          upstream.pipe(client);
          client.on('error', () => upstream.destroy());
          upstream.on('error', () => client.destroy());
        });
        server.listen($port, '127.0.0.1');
      " &
    fi
  done
fi

# Small delay for bridges to bind
sleep 0.2

# Compile agent-runner TypeScript (source is bind-mounted per-group at /app/src)
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
exec node /tmp/dist/index.js
