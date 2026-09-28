---
name: wordpress-plugin-to-emdash
description: Analyze and port WordPress plugin behavior, custom post types, shortcodes, admin workflows, and stored data to current EmDash extension points. Use for WordPress-plugin migrations or when deciding which behavior belongs in an EmDash plugin, site schema, seed, or Astro code. Do not use for visual theme ports without plugin functionality.
---

# Port a WordPress plugin to EmDash

Preserve the plugin's user-visible behavior and data model without translating PHP line by line. WordPress and EmDash divide responsibilities differently, so first decide whether each feature belongs in site schema, Astro code, a sandboxed plugin, or a trusted native plugin.

Load [creating-plugins](../creating-plugins/SKILL.md) before implementing plugin code. Load [building-emdash-site](../building-emdash-site/SKILL.md) when the port changes collections, seeds, queries, or frontend templates. Those skills define the current APIs; this skill covers migration decisions.

## Understand the source

Inspect the plugin source, installation behavior, database changes, hooks, REST endpoints, scheduled work, admin screens, shortcodes or blocks, frontend output, permissions, and external services. Identify behavior that users rely on separately from WordPress-specific implementation.

Record:

- required content and configuration data;
- actions that mutate or publish data;
- authorization and trust boundaries;
- background or retry behavior;
- frontend and administrator interactions;
- import, migration, and rollback needs;
- license obligations for copied assets or code.

If the source, expected behavior, or target EmDash environment is missing, report the gap instead of inventing an equivalent.

## Assign each responsibility

| WordPress responsibility                        | EmDash destination                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Custom post type, taxonomy, or metadata         | Collection, taxonomy, and fields created through the site schema or seed                                     |
| Site-wide presentation setting                  | Site setting read by Astro templates                                                                         |
| Plugin-owned user settings                      | `ctx.settings`; declare credentials as encrypted `secret` fields                                             |
| Plugin-owned cursors, caches, or internal state | Plugin-scoped `ctx.kv`                                                                                       |
| Plugin-owned queryable records                  | Declared `ctx.storage.<collection>` storage                                                                  |
| Content discovery, translation, or publication  | Capability-gated `ctx.content` and `ctx.schema`; policy hooks and actions have separate authority            |
| Runtime taxonomy or redirect management         | `ctx.taxonomies` or `ctx.redirects` with narrow read/write capability                                        |
| Comment administration                          | `ctx.comments`; reads expose personal data and moderation uses expected status                               |
| WordPress REST endpoint                         | Declared plugin route with explicit methods, inputs, headers, and response mode                              |
| Scheduled event                                 | `cron` hook and `ctx.cron` scheduling                                                                        |
| Admin page or form                              | Block Kit for sandboxed plugins; React only for a trusted native plugin                                      |
| Post editor metabox or saved-entry action       | `admin.editorPanels` or `admin.editorActions` on private routes                                              |
| User or author lookup                           | `ctx.users` with `users:read`                                                                                |
| Outbound HTTP request                           | `ctx.http.fetch()` with `network:request` and an `allowedHosts` entry                                        |
| Media operation                                 | Separate metadata, byte-read, metadata-write, and upload/delete authorities                                  |
| `WP_Query` or template tag                      | EmDash content API in Astro site code                                                                        |
| Shortcode or editor block                       | Existing Portable Text content where possible; a custom Portable Text block requires a trusted native plugin |
| Raw head markup or scripts                      | Trusted native `page:fragments`; registry-installed plugins can contribute validated `page:metadata` only    |

Do not create collections or taxonomies by reaching into EmDash system tables. Use the public schema, seed, CLI, or admin boundary. Do not use internal REST routes to imitate a sandbox API that does not exist.

Keep authorities separate: reading media metadata does not grant bytes, moderation does not grant deletion, publication policy does not grant publication actions, and content restore does not grant ordinary content reads.

## Choose the plugin format

Use a sandboxed plugin by default. It supports portable hooks, routes, declared storage, media, network access, MCP tools, and Block Kit admin UI through an install-time trust contract.

Use a trusted native plugin only when the feature requires host-process access, React admin code, Astro rendering components, raw page fragments, or custom Portable Text block definitions. State the extra authority and distribution limitation in the migration plan.

Some WordPress plugins do not need an EmDash plugin. A custom post type plus frontend templates may become only schema, seed data, and Astro pages. Do not add a runtime extension when static site structure covers the behavior.

## Plan data movement

Describe how existing WordPress data maps before writing runtime code:

- map post IDs, slugs, locales, authors, statuses, revisions, and publication dates;
- preserve relationships between posts, terms, media, and plugin-owned records;
- distinguish a one-time import from data that must continue syncing;
- make imports restartable and define how duplicates are detected;
- keep source identifiers when they are needed for reconciliation or redirects;
- identify content that cannot be represented without a product decision.

Use seed data for a new site's initial schema and sample content. Use an importer or migration path for an existing site's production data; a seed is not a backup or ongoing synchronization mechanism.

## Verify equivalent behavior

Test through the boundary that users and the runtime exercise:

- schema and imported-data assertions for content-model changes;
- production-boundary plugin tests for sandbox hooks, routes, storage, and permissions;
- browser verification for admin and frontend journeys;
- restart, duplicate-delivery, authorization, and failure cases when the source feature depends on them.

Compare observable behavior, not internal structure. Document intentional differences and any WordPress feature that remains unsupported.

## Deliver the port

Provide:

1. a concise inventory of the WordPress behavior and data;
2. the responsibility map and sandboxed/native decision;
3. the data migration or seed plan;
4. the implementation across plugin and site code;
5. verification evidence and known gaps;
6. attribution and license notices for reused code or assets.
