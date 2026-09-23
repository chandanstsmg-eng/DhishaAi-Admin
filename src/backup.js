'use strict';
/** `npm run backup` — writes a timestamped copy of the database file. */

const fs = require('fs');
const path = require('path');
const { DB_FILE, DATA_DIR } = require('./db');

const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(dir, `dhishaai-${stamp}.db`);

if (!fs.existsSync(DB_FILE)) {
  console.error(`No database found at ${DB_FILE}. Start the app once first.`);
  process.exit(1);
}

fs.copyFileSync(DB_FILE, target);
const kb = Math.round(fs.statSync(target).size / 1024);
console.log(`Backup written: ${target} (${kb} KB)`);

// Keep the 20 most recent copies.
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
for (const f of files.slice(0, Math.max(0, files.length - 20))) {
  fs.unlinkSync(path.join(dir, f));
  console.log(`Pruned old backup: ${f}`);
}
