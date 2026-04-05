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
echo "=== Starting EmDash server ==="
exec node ./dist/server/entry.mjs
