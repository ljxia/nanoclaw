#!/usr/bin/env npx tsx
/**
 * Set additionalMounts for a group.
 * Usage: npx tsx scripts/set-group-mount.ts <folder> <hostPath> [options]
 *
 * Options:
 *   --readonly            Mount as read-only (default: read-write)
 *   --container-path NAME Override container path name
 *   --ports 3000,5432     Ports to auto-bridge into container
 *   --exec-timeout MS     host_exec timeout in ms (default: 600000)
 *   --exec-max-output B   host_exec output cap in bytes (default: 204800)
 *
 * Examples:
 *   npx tsx scripts/set-group-mount.ts discord_yentown-notes ~/src/rolypoly
 *   npx tsx scripts/set-group-mount.ts discord_yentown-notes ~/src/rolypoly --ports 3000,5432 --exec-timeout 900000
 */
import Database from 'better-sqlite3';
import path from 'path';

const args = process.argv.slice(2);

function usage(): never {
  console.error('Usage: npx tsx scripts/set-group-mount.ts <folder> <hostPath> [--readonly] [--container-path NAME] [--ports P1,P2] [--exec-timeout MS] [--exec-max-output BYTES]');
  process.exit(1);
}

if (args.length < 2) usage();

const folder = args[0];
const hostPath = args[1];
let readonly = false;
let containerPath: string | undefined;
let ports: number[] | undefined;
let execTimeout: number | undefined;
let execMaxOutput: number | undefined;

for (let i = 2; i < args.length; i++) {
  switch (args[i]) {
    case '--readonly':
      readonly = true;
      break;
    case '--container-path':
      containerPath = args[++i];
      break;
    case '--ports':
      ports = args[++i].split(',').map(p => parseInt(p, 10));
      if (ports.some(isNaN)) {
        console.error('Invalid port numbers');
        process.exit(1);
      }
      break;
    case '--exec-timeout':
      execTimeout = parseInt(args[++i], 10);
      if (isNaN(execTimeout) || execTimeout <= 0) {
        console.error('Invalid exec-timeout');
        process.exit(1);
      }
      break;
    case '--exec-max-output':
      execMaxOutput = parseInt(args[++i], 10);
      if (isNaN(execMaxOutput) || execMaxOutput <= 0) {
        console.error('Invalid exec-max-output');
        process.exit(1);
      }
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      usage();
  }
}

const dbPath = path.join(process.cwd(), 'store', 'messages.db');
const db = new Database(dbPath);

const row = db
  .prepare('SELECT jid, container_config FROM registered_groups WHERE folder = ?')
  .get(folder) as { jid: string; container_config: string | null } | undefined;

if (!row) {
  console.error(`Group with folder "${folder}" not found in registered_groups.`);
  process.exit(1);
}

const existing = row.container_config ? JSON.parse(row.container_config) : {};

const mount: Record<string, unknown> = { hostPath, readonly };
if (containerPath) mount.containerPath = containerPath;
if (ports) mount.ports = ports;
if (execTimeout) mount.execTimeout = execTimeout;
if (execMaxOutput) mount.execMaxOutput = execMaxOutput;

// Append to existing mounts or create new array
const mounts = existing.additionalMounts || [];
// Replace if same hostPath already exists, otherwise append
const idx = mounts.findIndex((m: { hostPath: string }) => m.hostPath === hostPath);
if (idx >= 0) {
  mounts[idx] = mount;
} else {
  mounts.push(mount);
}
existing.additionalMounts = mounts;

db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(
  JSON.stringify(existing),
  row.jid,
);

console.log(`Updated container_config for ${folder} (jid: ${row.jid}):`);
console.log(JSON.stringify(existing, null, 2));

db.close();
