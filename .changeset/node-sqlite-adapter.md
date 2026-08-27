---
"emdash": minor
---

Updates `sqlite()` and the EmDash CLI to use Node.js's built-in SQLite driver. Node.js deployments can install and run EmDash without compiling or downloading the `better-sqlite3` native add-on. Existing SQLite database files and `sqlite({ url })` configuration continue to work.

This release requires Node.js 22.16 or later. Check the installed version with `node --version` and upgrade Node.js before updating EmDash if it reports an earlier release.

Node.js 22 prints its standard `ExperimentalWarning: SQLite is an experimental feature` message when the SQLite adapter loads. Node.js 24 does not print this warning.

If `better-sqlite3` is listed in the site's `package.json` only for EmDash, remove that dependency after updating.
