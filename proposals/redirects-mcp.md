---
title: Manage redirects and inspect 404 logs through MCP
type: rfc
status: proposed
authors:
  - Ondřej Varga (@onvarga)
champion: Ondřej Varga (@onvarga)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4952
created: 2026-11-18
---

# Manage redirects and inspect 404 logs through MCP

## Summary

Add six tools to the official EmDash Model Context Protocol (MCP) server. Clients can browse, create, and edit redirect rules, search stored 404 paths, and rank missing paths by recorded hits. The tools reuse the current redirect validation, permissions, and cache invalidation. A revision check protects edits made since a client read a rule.

## Problem and user case

After moving an EmDash site, operators need to find old URLs that visitors still request and check whether a redirect rule already covers them. Creating or correcting each rule in the admin repeats work when the operator has already reviewed the source path and destination through their MCP client. An authenticated production check on 18 November 2026 returned `settings_get` successfully and found no redirect or 404 tools in the complete `tools/list` response. The upstream core registration has the same gap. [MCP server at f0c28ef](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/mcp/server.ts)

The REST API already supports listing, inspecting, creating, and editing rules, and listing and summarizing 404s. MCP clients could complete that workflow through their existing connection. [REST routes](https://github.com/emdash-cms/emdash/tree/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/astro/routes/api/redirects)

## Example

A client asks for the ten most frequently requested missing paths.

```json
{
  "name": "redirect_404_summary",
  "arguments": { "limit": 10 }
}
```

An example item is `{ "path": "/old-events", "count": 42, "lastSeen": "2026-11-18T15:04:00.000Z" }`. The client searches `redirect_list` with `{ "search": "/old-events" }` and checks how the old URL responds. After the operator confirms that `/events` is the intended destination, the client creates the rule.

```json
{
  "name": "redirect_create",
  "arguments": { "source": "/old-events", "destination": "/events", "type": 301 }
}
```

If an existing rule needs correction, the client calls `redirect_get` with the rule ID, then sends its returned `_rev` and the changed fields in `redirect_update`. The client verifies the saved rule and the HTTP status and `Location` for the old URL.

## Goals

- Inspect saved redirect rules through the existing site MCP connection.
- Prioritize recurring 404 paths and browse the retained log by path.
- Create and edit individual redirect rules, including disabling a rule when needed.
- Enforce the current redirect read permission and expose only the 404 fields needed for triage.

## Non-goals

Redirect deletion, bulk operations, automatic redirect suggestions or creation from 404s, and 404 log clearing or pruning are outside this RFC.

## Detailed design

Register the six core tools through the server's standard MCP response wrapper.

| Tool | Arguments | Successful payload | Handler |
| --- | --- | --- | --- |
| `redirect_list` | Optional `limit`, `cursor`, `search`, `group`, `enabled`, `auto` | `{ items: Redirect[], nextCursor? }` | `handleRedirectList` |
| `redirect_get` | Non-empty `id` | `{ item: Redirect, _rev }` | Existing versioned redirect lookup |
| `redirect_create` | `source` and optional `destination`, `type`, `enabled`, `groupName` | `{ item: Redirect }` | `handleRedirectCreate` |
| `redirect_update` | `id`, `_rev` and at least one of `source`, `destination`, `type`, `enabled`, `groupName` | `{ item: Redirect }` | `handleRedirectUpdate` |
| `redirect_404_list` | Optional `limit`, `cursor`, `search` | `{ items: [{ path, createdAt }], nextCursor? }` | `handleNotFoundList` |
| `redirect_404_summary` | Optional `limit` | `{ items: [{ path, count, lastSeen }] }` | `handleNotFoundSummary` |

Use the existing filter semantics, ordering, and opaque cursor format. `limit` is an integer from 1 to 100 and defaults to 50 for both lists and the summary. The two paginated tools accept cursors up to 2,048 characters and return `nextCursor` only when another page is available. The MCP inputs use JSON booleans for `enabled` and `auto`. `Redirect` uses the existing REST record schema, including the rule's status in `type`, flags, group, and hit counters. The list response contains only the page and its cursor. [Redirect schemas](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/schemas/redirects.ts)

The 404 list searches by stored pathname and orders results newest by `createdAt`, with the existing ID tiebreaker. `createdAt` is when the retained row was first recorded. Repeated hits for that path update the count and `lastSeen` used by the summary. The summary is a top-N view ordered by descending recorded hits and has no cursor or date filter. Counts reflect retained rows and can reset when a path is pruned and recorded again. [Handlers](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/handlers/redirects.ts) · [Repository](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/database/repositories/redirect.ts)

### Creating and editing rules

Reuse the REST mutation schemas, with JSON integers for `type`. Creation defaults to `301` and `enabled: true`. Redirect statuses `301`, `302`, `307`, and `308` require a site-relative destination. Terminal rules `410` and `451` store an empty destination. An update applies only the supplied fields, with the existing terminal-status normalization. Use `groupName: null` to clear a group and `enabled: false` to disable a rule. EmDash derives pattern status from `source` and manages the `auto` flag internally. Preserve the existing validation for paths, pattern parameters, duplicate sources and redirect loops. [Mutation schemas](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/schemas/redirects.ts) · [Write handlers](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/handlers/redirects.ts)

Read the rule and its configuration revision from the same row snapshot. Return an opaque `_rev` bound to the rule ID, reusing the existing versioned redirect mechanism. Require that value on update and pass the decoded revision to the existing conditional write. A concurrent configuration change yields `CONFLICT`. Ordinary hit-counter updates do not invalidate a configuration revision. The write result returns the saved row. A client obtains a new revision with `redirect_get` before another edit. [Versioned redirect access](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/plugins/context.ts)

Keep the handlers' write locking and redirect artifact publication. After a successful create, invalidate the source path through the existing cache helper. After an update, invalidate the previous and saved source paths. Use the previous source from the snapshot selected by the revision check and retain the helper's trailing-slash handling. [Create route](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/astro/routes/api/redirects/index.ts) · [Update route](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/astro/routes/api/redirects/%5Bid%5D.ts)

Mark list, get, and 404 tools with `readOnlyHint: true`. Mark create and update with `readOnlyHint: false` so the existing site-import write fence applies. Creation adds a rule and update can overwrite live routing, so set `destructiveHint: false` on create and `destructiveHint: true` on update. Both descriptions explain that an enabled rule affects public requests.

## Compatibility and migration

The interface is additive and uses the current redirect and 404 tables, including the existing configuration revision. Existing tokens retain their current scopes. Clients using restricted tokens discover the new names through the MCP catalog and request the scopes needed for their workflow. On rollback, rules created or changed through MCP remain accessible through the admin and REST routes.

## Security and privacy

Require the new MCP scope `redirects:read` plus the existing `redirects:read` role permission for the four read tools, currently available to Editors and Admins. Require the separate MCP scope `redirects:write` plus the existing `redirects:manage` role permission for create and update, currently Admin-only. A client that reads and writes needs both scopes or the existing `admin` scope. The role permission is checked on every call. Add both scopes to personal access token issuance and OAuth discovery and consent, using existing scope validation and localized labels where applicable. Plugin capabilities are specific to the plugin runtime. [Role permissions](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/auth/src/rbac.ts)

Project each 404 response to the fields in the table before creating either text or structured MCP output. Keep IP addresses, user agents, referrers, top referrers, and raw rows inside the server. Derive the cursor from the original page as the existing handler does. Stored path strings can still contain personal or attacker-controlled content. Treat them as untrusted data and keep both 404 tools behind the same scope and role checks.

## Performance

Measure catalog size and cold initialization with the six schemas. Profile the 404 summary on a near-cap log and redirect edits with a representative rule set, including publication and cache invalidation. The tool calls use the existing authorization, database and cache paths. Logged-out URL handling uses the current middleware.

## Failure handling

Return successful empty lists for unmatched filters and `NOT_FOUND` for a missing rule ID. Preserve `INVALID_CURSOR`, `INVALID_PRECONDITION` for a malformed or wrong-rule revision, `CONFLICT` for a duplicate source or stale revision, `REDIRECT_BUSY` for lock contention, and the operation's existing errors. Validation and authorization failures precede the mutation. Reads can be retried. Pagination can reflect concurrent changes or retention cleanup.

On an uncertain create, search by source and compare the exact saved rule with the intended rule before deciding whether to retry. On an uncertain update or a stale revision, reload the rule by ID and reconcile its fields before deciding whether another edit is needed. A saved rule and a verified public response are separate checks. Existing artifact publication and edge cache invalidation can log failures after the rule has been committed, so a stale response calls for cache diagnosis and an HTTP recheck.

## Verification

- Exercise the six tools through the official MCP transport with an isolated database.
- Assert list filters, typed booleans, default and maximum limits, pagination, invalid cursors, empty results, and missing rule handling. Compare returned rules with the REST read endpoints.
- Record repeated 404 hits for one path and verify list search, summary order, count, and timestamps. Seed IP, user-agent and referrer values and verify their absence from every MCP response representation.
- Create a rule and edit its destination, source, and enabled state. Verify admin readback and public HTTP status and `Location`, including a cached pre-edit response and the previous source after a move.
- Cover rule validation, duplicate sources, loops, terminal statuses, invalid revisions, concurrent admin edits, and write fencing during site import. Verify that ordinary redirect hits do not cause false revision conflicts.
- Verify that a properly scoped Editor can read and an appropriately scoped Admin can write. Deny writes with a read-only token or an Editor role, including use of an `admin`-scoped token without the required role. Cover both scopes through PAT and OAuth.
- Run applicable SQLite, PostgreSQL and Cloudflare D1 coverage. Confirm that ordinary MCP calls, public redirects, and REST responses retain their existing behavior.

## Rollout and implementation

After design acceptance, wire the scopes, handlers, revision checks, and cache invalidation into MCP. Update the MCP reference and add the package changeset. Verify reads and a full create-and-edit flow on a disposable site. Enable the write tools in a production client's allowlist only where that workflow is needed.

## Alternatives

The admin and REST API already cover the operator workflow for clients that can switch interfaces. A site-local plugin could expose this workflow for one installation. Core tools give EmDash users a common contract and enforce the same read permission as the admin. Returning the full REST 404 payload would include request metadata that the triage workflow does not need.

## Drawbacks

Six tools expand the core catalog and introduce two token scopes. Editing takes a read to obtain the current revision. Enabled rules can change live routing immediately. Authorized clients can see retained paths, which may contain sensitive strings even without request headers.

## Open questions

- Identify a Maintainer sponsor.
- Confirm the tool names and whether the filtered log and ranked summary are both useful enough to expose as separate tools.
