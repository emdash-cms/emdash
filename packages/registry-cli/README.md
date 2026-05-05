# @emdash-cms/registry-cli

CLI for the experimental EmDash plugin registry.

> EXPERIMENTAL: there is no aggregator deployed yet, so `search` / `info` / discoverable `publish` don't have a server to talk to. `bundle`, `login`, `whoami`, and putting records in your own atproto repo all work today. NSIDs and shapes will change while RFC 0001 is in flight. Pin to an exact version.

## Installation

```sh
npx @emdash-cms/registry-cli bundle
```

Or install globally:

```sh
npm install -g @emdash-cms/registry-cli
emdash-registry bundle
```

## Commands

```text
emdash-registry login <handle-or-did>          Interactive atproto OAuth login
emdash-registry logout [--did <did>]           Revoke the active session
emdash-registry whoami                         Show stored sessions
emdash-registry search <query>                 Free-text search
emdash-registry info <handle-or-did> <slug>    Show package details
emdash-registry bundle                         Bundle a plugin source dir into a tarball
emdash-registry publish --url <url>            Publish a release that points at a hosted tarball
```

All commands accept `--json`. Discovery commands accept `--aggregator <url>` (or `EMDASH_REGISTRY_URL`).

## Publishing

Three steps. The CLI does not host artifacts — you do, anywhere public.

```sh
emdash-registry bundle
# upload dist/<id>-<version>.tar.gz somewhere public
emdash-registry publish --url https://example.com/foo-1.0.0.tar.gz
```

On first publish, pass `--license` and `--security-email` (or `--security-url`) to bootstrap the package profile.

## Programmatic API

```ts
import { bundlePlugin } from "@emdash-cms/registry-cli";

const result = await bundlePlugin({ dir: "./my-plugin" });
```

For discovery and credentials, import from `@emdash-cms/registry-client`.
