#!/bin/sh
set -e

echo "=== EmDash Startup Diagnostics ==="
echo "Node version: $(node -v)"
echo "Working dir:  $(pwd)"
echo "Data dir:     $(ls -la data/ 2>&1 || echo 'MISSING')"
echo "Uploads dir:  $(ls -la uploads/ 2>&1 || echo 'MISSING')"

# Verify better-sqlite3 native bindings load correctly
echo ""
echo "--- Checking better-sqlite3 ---"
node -e "
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.close();
    console.log('OK: better-sqlite3 native bindings loaded successfully');
  } catch (e) {
    console.error('FAIL: better-sqlite3 cannot load:', e.message);
    console.error(e.stack);
  }
"

# Verify the data directory is writable
echo ""
echo "--- Checking data directory ---"
node -e "
  const fs = require('fs');
  try {
    const testFile = './data/.write-test';
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('OK: data directory is writable');
  } catch (e) {
    console.error('FAIL: data directory is NOT writable:', e.message);
  }
"

# Check environment
echo ""
echo "--- Environment ---"
echo "NODE_ENV:              ${NODE_ENV:-not set}"
echo "HOST:                  ${HOST:-not set}"
echo "PORT:                  ${PORT:-not set}"
echo "EMDASH_AUTH_SECRET:    ${EMDASH_AUTH_SECRET:+set (hidden)}${EMDASH_AUTH_SECRET:-EMPTY or not set}"
echo "DATABASE_URL:          ${DATABASE_URL:-not set (using default)}"

echo ""
echo "--- Checking EMDASH_RESET_SETUP ---"
if [ "${EMDASH_RESET_SETUP}" = "true" ]; then
  echo "EMDASH_RESET_SETUP=true detected — clearing setup_complete flag..."
  node -e "
    const Database = require('better-sqlite3');
    const dbPath = process.env.DATABASE_URL
      ? process.env.DATABASE_URL.replace(/^file:/, '')
      : './data/data.db';
    try {
      const db = new Database(dbPath);
      const result = db.prepare(\"DELETE FROM _emdash_options WHERE key = 'emdash:setup_complete'\").run();
      db.close();
      if (result.changes > 0) {
        console.log('OK: setup_complete flag cleared — setup wizard will appear on next visit');
      } else {
        console.log('OK: setup_complete flag was not set (already cleared or fresh install)');
      }
    } catch (e) {
      console.error('WARN: could not clear setup flag (DB may not exist yet — that is fine on first boot):', e.message);
    }
  "
else
  echo "OK: skipped (set EMDASH_RESET_SETUP=true to trigger a setup reset)"
fi

echo ""
echo "--- Checking first-boot seed ---"
node -e "
  const fs = require('fs');
  const dbPath = (process.env.DATABASE_URL || 'file:./data/data.db').replace(/^file:/, '');
  const seedFlag = './data/.seeded';
  const seedFile = './seed/seed.json';
  if (!fs.existsSync(dbPath) && !fs.existsSync(seedFlag) && fs.existsSync(seedFile)) {
    console.log('First boot detected — applying seed...');
    try {
      require('child_process').execSync(
        'node ./node_modules/.bin/emdash seed ' + seedFile,
        { stdio: 'inherit' }
      );
      fs.writeFileSync(seedFlag, '');
      console.log('OK: seed applied');
    } catch (e) {
      console.error('WARN: seed failed (non-fatal):', e.message);
    }
  } else {
    console.log('OK: skipped (DB already exists or already seeded)');
  }
"

echo ""
echo "=== Starting EmDash server ==="
exec node ./dist/server/entry.mjs
