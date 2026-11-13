---
title: Forms and submissions as MCP tools
type: feature-plan
status: proposed
authors:
  - Noah Eisenbruch (@eisenbruch)
discussion: https://github.com/emdash-cms/emdash/discussions/1587
created: 2026-11-13
---

# Forms and submissions as MCP tools

This plan records the design behind #4027, a working implementation that has run on our production site as a patch since October. #4027 will be rebased and updated to match once this plan is accepted.

## Problem and user case

Every private plugin route requires the `admin` token scope (`authorizePrivatePluginRouteRequest`), whatever permission the route declares. An agent that works a site's content through the MCP server, with a token that deliberately has no `admin`, therefore cannot see what arrived through the site's forms. On our site that means it cannot read listing claims or business submissions, and an editor copies them across by hand.

Plugin MCP tools (#2002, Discussion #1587) are the designed way for a plugin to offer routes to such a token. The forms plugin declares none.

## Proposed behavior

The forms plugin declares four MCP tools, each bound to an existing private route:

| Tool                 | Route                | Route permission |
| -------------------- | -------------------- | ---------------- |
| `forms_list`         | `forms/list`         | `plugins:read`   |
| `submissions_list`   | `submissions/list`   | `plugins:read`   |
| `submissions_get`    | `submissions/get`    | `plugins:read`   |
| `submissions_update` | `submissions/update` | `plugins:manage` |

`submissions_update` sets a submission's status (new, read, archived), its star and its notes. It never changes what the visitor sent.

A call succeeds only when the token holds `mcp:tools` or `mcp:tools:emdash-forms`, and the token's user has the route's permission, as for every plugin tool (`packages/core/src/mcp/server.ts`). So an Editor's token can list forms and read submissions, and only an Admin's token can triage them, the same split the REST routes have.

`forms/list` gains optional `limit` (1 to 100, default 100) and `cursor`, so the tool can page. Its input is `formsListSchema.prefault({})`, so the admin's existing calls, which send `{}`, and a caller that sends no body still get the first 100.

## Goals

- Let a token without `admin` read a site's forms and submissions through the MCP server, subject to the token's scope and its user's role.
- Let an Admin's token triage submissions.
- Change nothing for REST callers.

## Non-goals

- Deleting or exporting submissions over MCP. Export is unbounded and both are larger things to hand to a token.
- Creating, editing, duplicating or deleting forms over MCP.
- Changing how plugin MCP tools are authorized, or the `admin` requirement on private plugin routes.
- The wider tool set in #2229 (closed October 16, 2026).

## Interfaces and compatibility

- **Plugin surface:** the forms plugin's `mcp.tools` gains four entries. No change to the plugin API.
- **Routes:** `forms/list` accepts an optional `limit` and `cursor`; without them it behaves as today. `submissions/update` states `permission: "plugins:manage"` explicitly, because a tool can only bind to a route that names its permission; that was already its default, so REST access is unchanged.
- **Stored data and configuration:** none.

## Errors and edge cases

- A token without the plugin MCP scope gets `INSUFFICIENT_SCOPE: requires mcp:tools:emdash-forms`; a user without the route's permission is refused the same way as on REST. Both are logged through the existing plugin MCP denial path.
- A tool bound to a route that does not exist, is not private, names no permission, or is not a JSON POST route is dropped silently by the runtime. A test asserts each of these for all four tools, so a later route change cannot remove a tool unnoticed.
- `limit` outside 1 to 100 is a validation error. An empty or missing body returns the first 100 forms.
- Submissions are personal data a visitor sent. Today only an `admin`-scoped token can read them; with this plan, a token that holds the plugin MCP scope can too, if its user's role may read them in the admin. That widening is the point of the plan, and it is opt-in twice: the token has to be issued with the scope, and the role check is the one the admin UI already applies. No other path to the routes changes.

## Verification

- Unit: the four tools are declared and bind to existing private JSON POST routes that name a permission; delete, export and the form-editing routes are not bound; REST permissions are unchanged; the forms list pages and still accepts an empty or missing body.
- Manual, on a deployed site with a token holding only `content:read` and `mcp:tools`: the four tools are listed, `forms_list` returns the site's forms, `submissions_list` and `submissions_get` return a form's submissions, and a token without `mcp:tools` is refused. `submissions_update` is checked with an Admin's token and refused for an Editor's.
