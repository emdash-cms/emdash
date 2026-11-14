---
title: Load migration credentials from an env file
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-11-06
---

# Load migration credentials from an env file

## Problem and user case

`emdash migrate` reads target credentials such as `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`, and `TURSO_AUTH_TOKEN` only from the process environment. Site builders often keep these values in `.env` or `.env.local`. Astro and Wrangler read those files, but `emdash migrate` does not. A local run then fails with an error such as `A valid Cloudflare account ID is required for D1 migrations.`, and the message does not say that the variable exists in a file the command ignored. Issue [#2842](https://github.com/emdash-cms/emdash/issues/2842) reports this. On a D1 site running EmDash 1.4.0, a `CLOUDFLARE_API_TOKEN` stored only in `.env.local` makes `emdash migrate --status --wrangler-config wrangler.jsonc` exit with `CLOUDFLARE_API_TOKEN is required for D1 migrations.` Pull request [#4682](https://github.com/emdash-cms/emdash/pull/4682) documents the current behavior.

The current workaround is to source the file in a POSIX shell (`set -a && . ./.env.local && set +a`). Sourcing runs the file as a shell script: it expands `$` and backticks, runs an unquoted value that contains spaces as a command, and does not work in PowerShell or cmd.

## Proposed behavior

`emdash migrate` accepts a repeatable `--env-file <path>` option. Before it resolves the target, the command reads each file with dotenv syntax and adds its variables to the environment that the migration executor receives.

```bash
pnpm emdash migrate --status --env-file .env.local --wrangler-config wrangler.jsonc
```

- A variable that is already set in the process environment keeps its value. A file never overrides it, so secrets injected by a CI job take precedence over a file in the workspace.
- When several files set the same variable, the first file given wins. With `--env-file .env.local --env-file .env`, a value in `.env.local` takes precedence over one in `.env`.
- Relative paths resolve from the project root, like `--manifest` and SQLite paths.
- Without `--env-file`, the command behaves exactly as it does today. It never reads a file implicitly.
- Before it prints the target, the command writes each loaded file path to stderr, for example `Loaded environment from .env.local`. It never prints variable names or values.

## Goals

- Let a local `emdash migrate` run use credentials from a project env file without shell-specific steps.
- Keep the credential source explicit and visible for a command that can write to a production database.
- Keep CI behavior unchanged: real environment variables always win.
- Parse the file without executing it.

## Non-goals

- Loading `.env`, `.env.local`, or `.dev.vars` implicitly.
- Mode-specific files such as `.env.production`, or Vite's `loadEnv` precedence rules.
- Variable expansion (`${OTHER}`) inside values.
- Loading env files for other CLI commands.
- Changing the credential variable names or how the adapters resolve their targets.

## Interfaces and compatibility

- New CLI option `--env-file <path>` on `emdash migrate`, repeatable. It is documented in the CLI reference and in Manage core database migrations.
- The command parses files with Node's `util.parseEnv`, which supports `export NAME=value`, comments, and quoted values. EmDash requires Node 22.16 or later, and that version provides `parseEnv`. No dependency is added.
- The merged variables are passed only to the executor context and to the command's error redaction. The command does not modify `process.env`.
- The migration manifest, target fingerprint, executor protocol, and exit codes are unchanged. A target fingerprint does not depend on whether a credential came from a file or from the environment.

This is an additive change. Existing scripts and CI jobs see no difference.

## Errors and edge cases

- A missing or unreadable file fails before any database access, with exit code `1` and a message that names the path. The command does not fall back silently, because a mistyped path would otherwise run against whatever credentials the environment holds.
- A value that `parseEnv` cannot read as intended, such as an unterminated quote, follows Node's parsing rules. Malformed lines are not an error, so the documentation tells readers to check the target that `--status` prints.
- Values loaded from a file are redacted from executor error messages, the same way values from the environment are today.
- An empty value (`NAME=`) counts as set. The adapter reports it the same way it reports an empty environment variable.
- `--env-file` works together with `--expected-target-fingerprint`, `--json`, `--check`, `--status`, and the lock options.

## Verification

Unit tests for `runMigrateCommand` with injected dependencies and temporary files:

- A variable set only in the file reaches the executor context.
- A variable set in both the process environment and the file keeps the environment value.
- With two files, the first file's value wins.
- A missing file exits with code `1` before the executor factory is called.
- An executor error message that contains a file-loaded secret is redacted.
- `process.env` is unchanged after the command runs.
- Without `--env-file`, the executor context receives exactly the process environment.

Manual check: run `emdash migrate --status --env-file .env.local --wrangler-config wrangler.jsonc` against a real D1 database with the token and account ID only in `.env.local`, then confirm the printed target and that no value appears in the output.

## Open questions

- Should the command read `.env.local` and `.env` implicitly, as issue #2842 suggests first, instead of requiring the flag? This plan chooses the flag because the command can write to production and an implicit file is easy to forget in a CI workspace.
- Should `.dev.vars` be accepted as an input, given that Wrangler ignores `.env` when `.dev.vars` exists?
