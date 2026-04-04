#!/usr/bin/env tsx
/**
 * Migration 1.2.36: Switch scheduled tasks from isolated to group context mode.
 *
 * Tasks should share the group conversation so users can reply with context.
 * This is a one-time migration — new tasks already default to 'group'.
 */
import Database from 'better-sqlite3';
import path from 'path';

const projectRoot = process.argv[2] || process.cwd();
const dbPath = path.join(projectRoot, 'data', 'nanoclaw.db');

const db = new Database(dbPath);
const result = db.prepare(
  `UPDATE scheduled_tasks SET context_mode = 'group' WHERE context_mode = 'isolated'`,
).run();

console.log(`Migrated ${result.changes} task(s) from isolated to group mode`);
db.close();
