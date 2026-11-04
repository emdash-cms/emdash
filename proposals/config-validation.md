---
title: Validate emdash() options
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-10-21
---

# Validate emdash() options

## Problem and user case

Site builders configure EmDash in `astro.config.mjs`, which is usually plain JavaScript, so TypeScript never checks the options. `emdash()` validates only some of them (URLs, registry, migrations, plugin formats, admin locales and hidden navigation items). Everything else is accepted as is. `mcp: "true"` turns MCP on because the string is truthy, `toolbar: "always"` quietly behaves like no toolbar setting, and a misspelled option such as `sitUrl` is ignored without a word. The problem shows up later at runtime, far from the line that caused it.

Issue [#1025](https://github.com/emdash-cms/emdash/issues/1025) asks for a Zod schema with helpful error messages.

## Proposed behavior

When Astro loads the config, `emdash()` checks the type and shape of every documented option against a Zod schema.

- A value of the wrong type fails the build. The error lists every invalid option at once, each with its path:

  ```
  Invalid EmDash configuration:
  ✖ Invalid input: expected boolean, received string
    → at mcp
  ✖ Expected "server", "client" or `false`
    → at toolbar
  ```

- An unknown top-level option doesn't fail the build. EmDash logs a warning and suggests the closest option name when one is near:

  ```
  [WARN] [emdash] Unknown EmDash config option `sitUrl` is ignored. Did you mean `siteUrl`?
  ```

- Valid configurations behave exactly as before.

## Goals

- Catch wrongly typed options at build time with the option path in the message.
- Report all invalid options in one run, not one per build.
- Point out typos in option names without breaking configs that carry extra keys.
- Keep the schema and the `EmDashConfig` type from drifting apart.

## Non-goals

- Replacing the existing validators for `registry`, `migrations`, `middleware`, `siteUrl`, `allowedOrigins`, `marketplace`, `updateCheck.minimumReleaseAge`, plugin formats, `admin.locales` and `admin.hiddenNavItems`. They already produce specific messages and keep doing so. The schema only checks these fields' outer type where that adds something.
- Deriving `EmDashConfig` from the schema with `z.infer`. The interface carries the JSDoc that editors show for each option, and adapter descriptors (`database`, `storage`, `auth`, plugins) can only be expressed as opaque custom checks in Zod, so an inferred type would be less precise than the current one.
- Validating the inside of adapter, plugin and provider descriptors. The schema checks that each one is an object with an `entrypoint` (adapters, media providers) or an `id` (plugins, auth providers). Everything else belongs to the adapter.
- Warnings for unknown keys inside nested objects such as `admin`.

## Interfaces and compatibility

- No change to the `EmDashConfig` type or any other public API.
- The schema is typed against `EmDashConfig` with `satisfies { [K in keyof Required<EmDashConfig>]: z.ZodType }`. Adding an option to the interface without a schema entry, or the reverse, fails typecheck.
- Behavior change: a configuration with a value of the wrong type now fails the build, where it used to load. This only affects configs that don't match the documented types. It ships as a minor release with a changeset that shows the fix (for example `mcp: "true"` becomes `mcp: true`).
- Configs with unknown top-level keys keep working and now get a warning.
- No database, runtime or logged-out request cost. The check runs once, when the integration is created.

## Errors and edge cases

- Every option is optional, so `undefined` passes. Helpers like `sandbox()` that return `undefined` when they don't apply keep working.
- Plugins passed as default-export descriptor objects pass, since they carry an `id`.
- `maxUploadSize` must be a positive finite number, which matches the existing runtime check. Integers aren't required.
- Error messages come from `z.prettifyError`. Unions get a custom message (for example `Expected "server", "client" or \`false\``) because Zod's default for a failed union is a bare "Invalid input".
- The removed `experimental.registry` option keeps its existing migration error, which runs before the schema check.
- The unknown-option warning is logged in `astro:config:setup` through Astro's integration logger, once per command.

## Verification

- Unit tests that a typical config passes, that wrong values for `mcp`, `maxUploadSize`, `toolbar`, `database`, `plugins`, `admin.siteName` and `fonts` fail with their path, that several invalid options are reported together, that unknown top-level keys are returned instead of thrown, and that the warning suggests `siteUrl` for `sitUrl`.
- The existing integration tests keep passing, including the specific messages from the registry, migration, middleware and admin validators.
- `astro sync` passes for the demos and starter templates, which cover real adapters (SQLite, D1, R2, KV, Cloudflare Access) and plugin descriptors.
- A manual run in a demo with a wrong `mcp` value and a misspelled `siteUrl` shows the build error and the warning.

A working prototype is on the [`feat/config-zod-validation` branch of swissky/emdash](https://github.com/swissky/emdash/tree/feat/config-zod-validation).
