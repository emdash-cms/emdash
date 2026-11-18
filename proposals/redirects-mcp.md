---
title: Browse redirects and 404 logs through MCP
type: rfc
status: proposed
authors:
  - Ondřej Varga (@onvarga)
champion: Ondřej Varga (@onvarga)
sponsor: null
discussions: []
created: 2026-11-18
---

# Browse redirects and 404 logs through MCP

## Summary

Add four read-only tools to the official EmDash Model Context Protocol (MCP) server. Clients can browse redirect rules, retrieve a rule by ID, search stored 404 paths, and rank missing paths by recorded hits. The tools reuse the existing handlers and enforce the same role permission as the admin's read endpoints.

## Problem and user case

After moving an EmDash site, operators need to find old URLs that visitors still request and check whether a redirect rule already covers them. The admin and REST API support those checks. An authenticated production check on 18 November 2026 returned `settings_get` successfully and found no redirect or 404 tools in the complete `tools/list` response. The upstream core registration has the same gap. [MCP server at f0c28ef](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/mcp/server.ts)

The REST API already has list and detail routes for rules and list and summary routes for 404s. MCP clients could use the same data and permissions through their existing connection. [REST routes](https://github.com/emdash-cms/emdash/tree/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/astro/routes/api/redirects)

## Example

A client asks for the ten most frequently requested missing paths.

```json
{
  "name": "redirect_404_summary",
  "arguments": { "limit": 10 }
}
```

An example item is `{ "path": "/old-events", "count": 42, "lastSeen": "2026-11-18T15:04:00.000Z" }`. The client can search `redirect_list` with `{ "search": "/old-events" }` and inspect a matching rule using its ID. This lists configured rules. Confirming how a request is handled still requires checking the URL, especially when a pattern rule could apply.

## Goals

- Inspect saved redirect rules through the existing site MCP connection.
- Prioritize recurring 404 paths and browse the retained log by path.
- Enforce the current redirect read permission and expose only the 404 fields needed for triage.

## Non-goals

Redirect creation, editing, deletion, bulk operations, and 404 log clearing or pruning are outside this RFC. It also leaves URL matching, log retention, middleware, and admin and REST behavior outside the proposed change.

## Detailed design

Register the tools as core MCP tools with `readOnlyHint: true`. Return the following successful payloads through the server's standard MCP response wrapper.

| Tool | Arguments | Successful payload | Handler |
| --- | --- | --- | --- |
| `redirect_list` | Optional `limit`, `cursor`, `search`, `group`, `enabled`, `auto` | `{ items: Redirect[], nextCursor? }` | `handleRedirectList` |
| `redirect_get` | Non-empty `id` | `{ item: Redirect }` | `handleRedirectGet` |
| `redirect_404_list` | Optional `limit`, `cursor`, `search` | `{ items: [{ path, createdAt }], nextCursor? }` | `handleNotFoundList` |
| `redirect_404_summary` | Optional `limit` | `{ items: [{ path, count, lastSeen }] }` | `handleNotFoundSummary` |

Use the existing filter semantics, ordering, and opaque cursor format. `limit` is an integer from 1 to 100 and defaults to 50 for both lists and the summary. The two paginated tools accept cursors up to 2,048 characters and return `nextCursor` only when another page is available. The MCP inputs use JSON booleans for `enabled` and `auto`. `Redirect` uses the existing REST record schema, including the rule's status in `type`, flags, group, and hit counters. The list response contains only the page and its cursor. [Redirect schemas](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/schemas/redirects.ts)

The 404 list searches by stored pathname and orders results newest by `createdAt`, with the existing ID tiebreaker. `createdAt` is when the retained row was first recorded. Repeated hits for that path update the count and `lastSeen` used by the summary. The summary is a top-N view ordered by descending recorded hits and has no cursor or date filter. Counts reflect retained rows and can reset when a path is pruned and recorded again. [Handlers](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/api/handlers/redirects.ts) · [Repository](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/core/src/database/repositories/redirect.ts)

## Compatibility and migration

The interface is additive and uses the current redirect and 404 tables. No data migration is needed. Existing tokens retain their current scopes. Clients using a restricted token discover the new tool names through the usual MCP catalog and request the new scope before calling them. Rolling back the MCP additions leaves the admin and REST routes available.

## Security and privacy

Require a new MCP token scope named `redirects:read` and the existing role permission `redirects:read` on every call. The role permission currently requires Editor or Admin. The existing `admin` token scope satisfies the token check. Both scopes require the role check. Add the scope to personal access token issuance and OAuth discovery and consent, using existing scope validation and localized labels where applicable. The plugin capability with the same name is specific to the plugin runtime. [Role permissions](https://github.com/emdash-cms/emdash/blob/f0c28ef5e6c7f18662f279ff92f2657f6a9c2613/packages/auth/src/rbac.ts)

Project each 404 response to the fields in the table before creating either text or structured MCP output. Keep IP addresses, user agents, referrers, top referrers, and raw rows inside the server. Derive the cursor from the original page as the existing handler does. Stored path strings can still contain personal or attacker-controlled content. Treat them as untrusted data and keep both 404 tools behind the same scope and role checks.

## Performance

Each call uses the existing bounded read path. The 404 summary still aggregates retained rows, even for a small limit. Measure the four tool schemas' effect on catalog size and cold initialization, and profile list and summary calls on a near-cap 404 log. Public page requests gain no additional query or log write.

## Failure handling

Return successful empty lists for unmatched filters and `NOT_FOUND` for a missing rule ID. Keep `INVALID_CURSOR` and operation-specific read failures through the standard MCP error wrapper. Validation and authorization failures must occur before reading redirect data. A failed call can be retried. Pagination follows the live data and can reflect concurrent changes or retention cleanup.

## Verification

- Exercise the four tools through the official MCP transport with an isolated database.
- Assert list filters, typed booleans, default and maximum limits, pagination, invalid cursors, empty results, and missing rule handling. Compare returned rules with the REST read endpoints.
- Record repeated 404 hits for one path and verify list search, summary order, count, and timestamps. Seed IP, user-agent and referrer values and verify their absence from every MCP response representation.
- Verify that a properly scoped Editor can read, an Editor lacking the scope and a lower-role user cannot, and the `admin` token scope still requires the role check. Cover new-scope issuance through PAT and OAuth.
- Run applicable SQLite, PostgreSQL and Cloudflare D1 coverage. Confirm that ordinary MCP calls, public redirects, and REST responses retain their existing behavior.

## Rollout and implementation

After design acceptance, add token-scope plumbing, register the four tools, and wire the handlers and result projections. Update the MCP reference and add the package changeset. Verify the released catalog with scoped credentials and compare both 404 views with the admin on a disposable site before adopting the tools in production.

## Alternatives

The admin and REST API already cover the operator workflow for clients that can switch interfaces. A site-local plugin could expose this workflow for one installation. Core tools give EmDash users a common contract and enforce the same read permission as the admin. Returning the full REST 404 payload would include request metadata that the triage workflow does not need.

## Drawbacks

Four tools expand the core catalog and introduce another token scope. The MCP-specific projection needs tests when the REST response changes. Authorized clients can see retained paths, which may contain sensitive strings even without request headers.

## Open questions

- Identify a Maintainer sponsor.
- Confirm the tool names and whether the filtered log and ranked summary are both useful enough to expose as separate tools.
