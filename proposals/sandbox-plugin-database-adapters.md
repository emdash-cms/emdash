---
title: Database adapter support for Cloudflare sandbox plugins
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: TBD
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4405
created: 2026-10-25
---

# Database adapter support for Cloudflare sandbox plugins

## Summary

Make sandboxed plugins running through the Cloudflare Worker Loader use the database configured for the site. The `PluginBridge` currently constructs Kysely instances with `D1Dialect` and reads `env.DB` directly. On sites configured with Hyperdrive or Durable Objects SQL, bridge operations can fail or use a separate database if a D1 binding is also present.

This RFC proposes passing a serializable adapter descriptor to the Cloudflare sandbox runner and resolving it inside the trusted host runtime. Adapter-independent bridge operations will use core repositories or dialect-neutral Kysely queries. Connection-backed adapters will acquire and release resources within the bridge call. The bridge must preserve plugin capability checks and avoid retaining request-bound I/O across events.

## Problem and user case

The Cloudflare sandbox bridge is a separate Worker Entrypoint. It opens D1 connections directly, including in content, media, settings, and other database operations. A site using Hyperdrive or Durable Objects SQL therefore cannot reliably run sandboxed plugins against its configured database. If the deployment also has a D1 binding, some bridge calls can use a different database from the rest of EmDash.

The limitation is reported in [issue #1623](https://github.com/emdash-cms/emdash/issues/1623). It remains on current `upstream/main`: `packages/cloudflare/src/sandbox/bridge.ts` constructs D1 dialects with `this.env.DB`, and the Hyperdrive and plugin sandbox documentation says sandboxed plugins are D1-only.

A site operator using a supported Cloudflare database adapter should be able to run sandboxed plugins without adding a second database binding. Plugin reads and writes should use the same site data as operations performed outside the sandbox.

## Example

A site configures Hyperdrive and the Cloudflare sandbox runner:

```ts
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { hyperdrive, sandbox } from "@emdash-cms/cloudflare";

export default defineConfig({
	integrations: [
		emdash({
			database: hyperdrive({ binding: "HYPERDRIVE" }),
			sandboxRunner: sandbox(),
		}),
	],
});
```

When a sandboxed plugin calls `ctx.storage.get("settings", "theme")`, the bridge resolves the configured database for that call, reads the plugin's setting, and releases any connection it acquired. The plugin cannot select or supply a database binding.

## Goals

- Support sandboxed plugin database operations on the Cloudflare production adapters D1, Hyperdrive/PostgreSQL, and Durable Objects SQL.
- Make Cloudflare bridge operations use the site's configured database, including when a separate D1 binding is present.
- Keep adapter-specific connection and request-scope behavior inside the trusted host runtime.
- Release connection-backed resources after each bridge call, including when the operation fails.
- Preserve capability checks, plugin scoping, validation, locale behavior, storage indexes, and media-byte access through the configured storage binding.
- Cover all database-backed bridge surfaces: content and revisions; media metadata and upload/deletion bookkeeping; users; taxonomies and bylines; settings, plugin storage and KV; comments; redirects; cron; site-write fences; export epochs; and legacy KV cleanup. Operations delegated to runtime callbacks must also use the configured database.
- Keep the Node/workerd sandbox runner compatible with its existing injected `options.db`. This RFC's adapter-resolution changes apply to Cloudflare Worker Loader bridge calls.
- Remove the D1-only limitation from the Hyperdrive and sandbox deployment documentation after the supported adapters pass their tests.

## Non-goals

- Let plugins choose database adapters, bindings, credentials, or connection strings.
- Change plugin-facing database APIs or capabilities.
- Add adapters beyond those supported by the Cloudflare integration.
- Change sandbox support in non-Cloudflare runtimes.

## Detailed design

### Configuration flow

The runtime configuration has a `DatabaseDescriptor`, and `SandboxOptions` carries a Kysely database for runners that execute in-process. The current runner factory receives `SandboxOptions`, not the descriptor. Extend the trusted core-to-runner configuration so the Cloudflare sandbox runner receives the descriptor and can include its serializable fields in the `PluginBridge` binding properties. Keep this separate from host callbacks such as `beforeContentWrite`, `taxonomyWrite`, and `contentActions`.

Do not pass a Kysely instance, adapter callback, pool, or raw credential through the Worker Loader binding. Derive the descriptor from trusted site configuration, not plugin input. The Node/workerd runner continues using its injected database and does not need to reconstruct a connection from Cloudflare bindings.

### Bridge database lifecycle

Add a bridge-owned resolver for the supported Cloudflare production adapters. Dispatch through exact adapter identities; do not infer adapter type from arbitrary entrypoint suffixes. Unsupported or malformed descriptors must produce a host-side configuration error and must not silently fall back to D1.

Resolve the database for each database-backed bridge RPC. The lifetime boundary is one RPC, not a plugin invocation: Worker Loader calls can be separate events, and the bridge cannot retain request-bound sockets or stubs between them. Provide the scoped Kysely instance to that operation's repositories and queries. Dispose of adapter-owned resources in a `finally` path. Hyperdrive/PostgreSQL must use the configured uncached primary binding for every bridge RPC and close its event-scoped pool before the RPC completes. D1 must use the configured binding. Neither should depend on browser request cookies or route metadata unavailable to the bridge.

For Durable Objects SQL bridge scopes, route all bridge reads and writes to the primary. The current singleton adapter's bookmark sink can carry write bookmarks between dialects in an isolate, but replica waits are bounded and may proceed after timeout. Using the primary for bridge calls avoids depending on browser cookies or best-effort replica catch-up for plugin read-after-write behavior. A future design may evaluate replica routing with an explicit bookmark contract and tests.

Do not cache a request-bound connection, stub, transaction, or session on the `PluginBridge` instance or at module scope. Reuse adapter metadata only when it does not retain request-scoped I/O resources.

### Database operations and runtime callbacks

Route adapter-independent database operations through core repositories or dialect-neutral Kysely queries. Remove raw D1 `prepare()` calls from operations that must support all configured adapters. This includes direct SQL used for site-write fences and export epochs, KV reads/writes/listing and cleanup, storage batch writes, content create/delete fallbacks, taxonomy and user access, and media upload confirmation/deletion, in addition to operations currently using `D1Dialect`. Validate dynamic SQL identifiers and parameterize values.

Preserve existing behavior for capability checks, storage collection allowlists and indexes, content locale selection, media-usage activation and site-write fences, pagination, missing-table handling, and media-byte access through the configured storage binding. Database metadata operations must use the database adapter; media-byte operations must use the configured storage binding.

Some bridge methods delegate work to host runtime callbacks instead of querying from `PluginBridge`. Those callbacks currently close over the database passed when the runtime initializes the sandbox runner. Ensure callback implementations resolve the configured active database scope for their queries too; otherwise direct bridge operations and callback-backed writes can diverge. Preserve callback-specific behavior and do not replace those host callbacks with descriptor data.

### Error behavior

A missing binding, unsupported descriptor, connection failure, query failure, or resource-close failure must produce a useful host-side error and must not trigger a silent retry against another database. Keep the existing bridge RPC error serialization and plugin-facing errors consistent. Run cleanup after operation failures, and do not replace the original operation error with a cleanup error. Adapters without an owned connection still follow their supported no-op or Kysely cleanup behavior.

## Compatibility and migration

This is an additive runtime change for Cloudflare Worker Loader bridge calls. Existing D1 sites continue using their configured D1 database, and plugin-facing APIs remain unchanged. Sites using Hyperdrive or Durable Objects SQL gain bridge support without adding a D1 binding. Keep an `env.DB` fallback only if maintainers decide that direct construction of `PluginBridge` without a descriptor is a supported integration contract. A fallback must not mask a missing or invalid configured adapter in production.

The Node/workerd runner remains on its injected `options.db`; this RFC does not change that runner's database lifecycle. The change affects `emdash` sandbox options and `@emdash-cms/cloudflare` bridge and runner behavior. Both packages need release notes. No database schema migration is expected.

## Security and privacy

The Worker Loader plugin receives only the bridge RPC surface, not the descriptor, database credentials, bindings, Kysely instance, or driver pool. The bridge continues checking each capability and scoping plugin storage by plugin ID. Validate collection names and other dynamic identifiers before constructing queries. Read adapter configuration only from trusted EmDash configuration.

Review the implementation for I/O reuse across events, fallback to the wrong database, and resource leaks on error paths. Tests must verify that a D1 binding is not used when a non-D1 adapter is configured.

## Performance

This change adds no queries to logged-out page renders. It affects only bridge calls made by sandboxed plugins. Creating and closing a Hyperdrive pool per RPC has a cost, while reusing request-bound sockets across events is invalid on Workers. Measure bridge latency and pool creation and close behavior for representative plugin operations. If connection setup materially affects latency, evaluate an optimization separately and preserve event scoping.

## Failure handling

If adapter resolution or connection creation fails, fail the bridge call against the configured adapter and return the existing RPC error shape. Do not read or write through a coexisting D1 binding. Close each acquired connection after success or failure. Do not retry a failed write against another adapter. Logs may identify the operation and adapter category, but must not include secrets or user-provided content.

## Verification

- Add a regression test showing that a Hyperdrive-only bridge with no `DB` binding performs operations against the configured adapter.
- Verify that the bridge uses Hyperdrive when a D1 binding is also present.
- Test reads and writes against the same database used by non-sandboxed runtime operations on D1, Hyperdrive/PostgreSQL, and Durable Objects SQL.
- Verify connection creation and cleanup on successful and failed calls, and ensure connections are not reused across events.
- Test that Durable Objects SQL bridge calls use the primary and provide read-after-write behavior under the selected policy.
- Retain coverage for bridge capabilities, plugin scoping, storage indexes, content locale selection, media activation fences, media metadata, and RPC errors.
- Test host callbacks that perform bridge-triggered writes against the configured active database scope.
- Run Cloudflare and core package tests, typechecks, lint, and formatting. Use adapter-backed tests where supported; a fake pool that returns empty rows is insufficient.
- Run the full repository checks and adversarial review before opening the implementation pull request.

## Rollout and implementation

1. Resolve the legacy-fallback decision in this RFC.
2. Add adapter-neutral database resolution and operation tests in the Cloudflare package.
3. Pass the serializable descriptor through core sandbox options and Cloudflare runner bridge properties. Keep the Node/workerd runner on `options.db`.
4. Move all bridge direct SQL operations away from D1-only APIs, update host callback database resolution, and verify capability and behavior boundaries.
5. Remove the D1-only documentation after the supported adapters pass integration tests.
6. Add changesets for each affected published package and update this proposal's status and implementation link in the implementation pull request.

## Alternatives

- Keep the bridge D1-only and document the limitation. This preserves current behavior but leaves sandboxed plugins unusable with other supported adapters.
- Add a separate D1 database for the bridge. This can split plugin state from site content and does not meet the same-database requirement.
- Pass an open database connection or callback through the Worker Loader binding. This crosses a serialization and isolation boundary and can retain request-scoped I/O beyond its valid event.
- Keep raw D1 SQL and add separate implementations for PostgreSQL and Durable Objects SQL. This duplicates repository behavior and increases dialect-specific correctness risks.

## Drawbacks

- The bridge must maintain adapter resolution alongside core runtime adapter initialization.
- Hyperdrive resource creation and teardown add work to each database-backed bridge call.
- Durable Objects SQL bridge operations use the primary, foregoing replica routing for those calls.
- Real adapter tests may require Workerd, a PostgreSQL test service, or fixtures beyond current unit mocks.

## Open questions

- Should the bridge use adapter entrypoints with a bridge-specific resolver, or a shared exported request-scope contract?
- Is constructing `PluginBridge` without a database descriptor a supported integration contract that requires a D1 fallback, or should missing descriptors fail closed?
- Which adapter-backed test environments should CI require for D1, Hyperdrive/PostgreSQL, and Durable Objects SQL?
- Which Maintainer will sponsor the RFC?
