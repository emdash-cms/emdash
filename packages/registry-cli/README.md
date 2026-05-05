# @emdash-cms/registry-cli

CLI for the experimental EmDash plugin registry. Atproto OAuth, FAIR-shaped records, sandboxed-plugin-only.

> EXPERIMENTAL: targets `com.emdashcms.experimental.*` and the experimental aggregator. NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.

## Installation

Run via npx (no install needed):

```sh
npx @emdash-cms/registry-cli search gallery
```

Or install globally:

```sh
npm install -g @emdash-cms/registry-cli
emdash-registry search gallery
```

## Commands

```text
emdash-registry login <handle-or-did>      Interactive atproto OAuth login
emdash-registry logout [--did <did>]       Revoke the active session
emdash-registry whoami                     Show stored sessions
emdash-registry search <query>             Free-text search
emdash-registry info <handle> <slug>       Show package details
emdash-registry info <at-uri>              Show package details by AT URI
emdash-registry publish                    NOT YET IMPLEMENTED
```

All commands accept `--json` for machine-readable output. Discovery commands accept `--aggregator <url>` to point at a different aggregator (or set `EMDASH_REGISTRY_URL`).

## Why a separate CLI

The publishing flow needs atproto OAuth, a loopback HTTP server, and Node-only dependencies. Most EmDash users (site owners, content editors) never publish a plugin, so we keep this surface out of the core CMS install.

Plugin authors install this CLI; site runtime stays atproto-free.

## Stability

While `0.x`:

- The `publish` subcommand is a stub. Use `emdash plugin publish` (legacy marketplace flow) until the registry-aware publish lands in a follow-up.
- The default aggregator host is provisional and will be retired at phase 1 cutover.
- Credential and OAuth state files are written under `~/.emdash/`; the schema is versioned and may evolve.
