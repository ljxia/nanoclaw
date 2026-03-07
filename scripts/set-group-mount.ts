#!/usr/bin/env npx tsx
/**
 * One-shot script: set additionalMounts for discord_yentown-notes group.
 * Usage: npx tsx scripts/set-group-mount.ts
 */
import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.cwd(), 'store', 'messages.db');
const db = new Database(dbPath);

const folder = 'discord_yentown-notes';

const row = db
  .prepare('SELECT jid, container_config FROM registered_groups WHERE folder = ?')
  .get(folder) as { jid: string; container_config: string | null } | undefined;

if (!row) {
  console.error(`Group with folder "${folder}" not found in registered_groups.`);
  process.exit(1);
}

const existing = row.container_config ? JSON.parse(row.container_config) : {};
existing.additionalMounts = [
  { hostPath: '~/src/rolypoly', readonly: false },
];

db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(
  JSON.stringify(existing),
  row.jid,
);

console.log(`Updated container_config for ${folder} (jid: ${row.jid}):`);
console.log(JSON.stringify(existing, null, 2));

db.close();
