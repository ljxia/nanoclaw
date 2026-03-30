#!/usr/bin/env npx tsx
/**
 * Migrate a group from one channel to another.
 * Copies group folder, session data, scheduled tasks, and DB registration.
 *
 * Usage: npx tsx scripts/migrate-channel.ts <old-folder> <new-jid> [new-folder]
 *
 * Examples:
 *   npx tsx scripts/migrate-channel.ts whatsapp_ryokan dc:1487478071073177751
 *   npx tsx scripts/migrate-channel.ts whatsapp_ryokan dc:1487478071073177751 discord_ryokan
 *
 * The new folder name is derived from the JID if not provided:
 *   dc:123       -> discord_<old-name>
 *   tg:123       -> telegram_<old-name>
 *   123@g.us     -> whatsapp_<old-name>
 *   123@line     -> line_<old-name>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');

const [oldFolder, newJid, explicitNewFolder] = process.argv.slice(2);

if (!oldFolder || !newJid) {
  console.error(
    'Usage: npx tsx scripts/migrate-channel.ts <old-folder> <new-jid> [new-folder]',
  );
  process.exit(1);
}

const db = new Database(DB_PATH);

// Find the old registration by folder
const oldRow = db
  .prepare('SELECT * FROM registered_groups WHERE folder = ?')
  .get(oldFolder) as
  | {
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      container_config: string | null;
      requires_trigger: number;
      is_main: number;
    }
  | undefined;

if (!oldRow) {
  console.error(`No registered group found with folder "${oldFolder}"`);
  process.exit(1);
}

// Derive channel prefix from JID
function channelPrefix(jid: string): string {
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) return 'whatsapp';
  if (jid.includes('@line')) return 'line';
  throw new Error(`Cannot determine channel from JID: ${jid}`);
}

// Strip channel prefix from old folder to get the base name
function baseName(folder: string): string {
  return folder.replace(/^(whatsapp|discord|telegram|line|slack)_/, '');
}

const newFolder =
  explicitNewFolder || `${channelPrefix(newJid)}_${baseName(oldFolder)}`;

console.log(`Migrating: ${oldFolder} (${oldRow.jid}) -> ${newFolder} (${newJid})`);

// 1. Copy group folder
const oldGroupDir = path.join(GROUPS_DIR, oldFolder);
const newGroupDir = path.join(GROUPS_DIR, newFolder);
if (!fs.existsSync(oldGroupDir)) {
  console.error(`Group folder not found: ${oldGroupDir}`);
  process.exit(1);
}
if (fs.existsSync(newGroupDir)) {
  console.error(`Destination folder already exists: ${newGroupDir}`);
  console.error('Remove it first or provide a different folder name.');
  process.exit(1);
}
fs.cpSync(oldGroupDir, newGroupDir, { recursive: true });
console.log(`  Copied group folder: ${oldFolder} -> ${newFolder}`);

// 2. Copy session data (.claude dir with session-env)
const oldSessionDir = path.join(DATA_DIR, 'sessions', oldFolder, '.claude');
const newSessionDir = path.join(DATA_DIR, 'sessions', newFolder, '.claude');
if (fs.existsSync(oldSessionDir)) {
  fs.mkdirSync(path.dirname(newSessionDir), { recursive: true });
  fs.cpSync(oldSessionDir, newSessionDir, { recursive: true });
  console.log(`  Copied session data`);
} else {
  console.log(`  No session data to copy (will be created on first run)`);
}

// 3. Copy IPC directory
const oldIpcDir = path.join(DATA_DIR, 'ipc', oldFolder);
const newIpcDir = path.join(DATA_DIR, 'ipc', newFolder);
if (fs.existsSync(oldIpcDir)) {
  fs.cpSync(oldIpcDir, newIpcDir, { recursive: true });
  console.log(`  Copied IPC directory`);
}

// 4. Register new group in DB
db.prepare(
  `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  newJid,
  oldRow.name,
  newFolder,
  oldRow.trigger_pattern,
  new Date().toISOString(),
  oldRow.container_config,
  oldRow.requires_trigger,
  oldRow.is_main,
);
console.log(`  Registered new group: ${newJid} -> ${newFolder}`);

// 5. Migrate scheduled tasks
const taskResult = db
  .prepare(
    `UPDATE scheduled_tasks SET group_folder = ?, chat_jid = ? WHERE group_folder = ?`,
  )
  .run(newFolder, newJid, oldFolder);
console.log(`  Migrated ${taskResult.changes} scheduled task(s)`);

// 6. Unregister old group
db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(oldRow.jid);
console.log(`  Unregistered old group: ${oldRow.jid}`);

console.log(`\nDone. Restart NanoClaw to apply: systemctl --user restart nanoclaw`);
console.log(
  `Old group folder kept as backup: ${oldGroupDir}\nDelete it when confirmed working: rm -rf ${oldGroupDir}`,
);
