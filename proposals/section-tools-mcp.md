---
title: Manage reusable sections through MCP
type: feature-plan
status: proposed
authors:
  - Aaron Koivunen (@koikar)
discussion: null
created: 2026-11-19
---

# Manage reusable sections through MCP

## Problem and user case

Editors can browse and manage reusable sections in the EmDash admin and through REST. The built-in MCP server has no section tools, so an agent using that connection cannot find or edit a reusable block such as a site-wide call to action in the section library. [Issue #138](https://github.com/emdash-cms/emdash/issues/138) closed on April 30, 2026. The gap remains on main. [Admin API client](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/admin/src/lib/api/sections.ts#L59-L110) · [REST list and create](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/astro/routes/api/sections/index.ts#L18-L58) · [REST get, update and delete](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/astro/routes/api/sections/%5Bslug%5D.ts#L23-L93) · [Core MCP registrations](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/mcp/server.ts#L1049-L4115)

This came up while managing EmDash sites through Tedix.

## Proposed behavior

Register five tools in `packages/core/src/mcp/server.ts`. Call the section handlers in process with the MCP runtime's database, and return their results through the standard MCP response wrapper. [In-process registration pattern](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/mcp/server.ts#L2139-L2199) · [Section handlers](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L24-L296) · [MCP response wrapper](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/mcp/server.ts#L514-L532)

| Tool | Input | Result |
| --- | --- | --- |
| `section_list` | Optional `search`, `source`, `limit` and `cursor` | `{ items, nextCursor? }` |
| `section_get` | Section slug | Section record |
| `section_create` | Create schema fields | Created section record |
| `section_update` | Current slug and partial update fields, including an optional replacement slug | Updated section record |
| `section_delete` | Section slug | `{ deleted: true }` |

Reuse `sectionsListQuery`, `createSectionBody` and `updateSectionBody`, and use the existing section and list response shapes. Listing defaults to 50 items and accepts 1–100. Use the returned `nextCursor` with the same filters to get the next page. Search matches title, description and keywords. Source can be `theme`, `user` or `import`. [Section schemas](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/schemas/sections.ts#L7-L67) · [List query and pagination](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/sections/index.ts#L112-L166) · [Delete result](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L256-L289)

## Goals

- Let agents find and manage reusable sections through the built-in MCP server.
- Apply the same validation and permissions as the section REST routes.

## Non-goals

- Section localization ([Discussion #4822](https://github.com/emdash-cms/emdash/discussions/4822)).
- Live section references ([Discussion #4823](https://github.com/emdash-cms/emdash/discussions/4823)). Writes affect only the library. Pages that already contain a copy keep their inserted blocks. [Editor insertion](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/admin/src/components/PortableTextEditor.tsx#L3295-L3337) · [Library update](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L222-L236) · [Library delete](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L275-L289)

## Interfaces and compatibility

Require both the token scope and the user's section permission. List and get require `content:read` and `sections:read` (Subscriber or higher). Create, update and delete require `content:write` and `sections:manage` (Editor or higher). Enforce both checks before calling the handler. [REST token scopes](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/astro/middleware/auth.ts#L832-L833) · [Section permissions](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/auth/src/rbac.ts#L64-L66) · [MCP scope and role checks](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/mcp/server.ts#L674-L705)

Mark list and get `readOnlyHint: true`. Register all three mutations under the existing site write fence and mark delete destructive. The proposal adds five MCP tools and requires no REST, configuration or stored-data changes. [MCP write fence](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/mcp/server.ts#L919-L963)

Add the five tools to the MCP reference inventory with their scopes and minimum roles. [MCP reference](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/docs/src/content/docs/reference/mcp-server.mdx#L82-L215) · [Inventory check](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/tests/unit/docs/reference-inventories.test.ts#L37-L83)

## Errors and edge cases

- Preserve structured handler errors. An invalid cursor returns `INVALID_CURSOR`. A missing section returns `NOT_FOUND`. Creating with a duplicate slug or renaming to one returns `CONFLICT`. [List errors](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L27-L50) · [Get errors](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L139-L157) · [Create conflict](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L82-L96) · [Rename conflict](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L177-L219)
- Update applies only supplied fields. Pass `previewMediaId: null` to remove the preview. [Update fields](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L222-L234)
- Deleting a theme-provided section returns `FORBIDDEN`. [Theme delete guard](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/api/handlers/sections.ts#L275-L289)

## Verification

Add `packages/core/tests/integration/mcp/sections.test.ts` using `connectMcpHarness`, with a real MCP client, server and test database. Check discovery and all five calls, filtered pagination, a successful rename and a rename conflict, partial updates and preview removal, and refusal to delete a theme section. Verify that a page with an inserted copy keeps its blocks after a library edit or delete. Test missing scope and insufficient role separately, including a Subscriber reading and an Editor writing with the corresponding scopes. During a site import, verify that reads still work and writes are refused. [MCP runtime harness](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/tests/utils/mcp-runtime.ts#L251-L314) · [Write-fence integration coverage](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/tests/integration/mcp/transfer.test.ts#L476-L511)

## Open questions

- Is a feature plan sufficient for an additive MCP interface using the existing section permissions, or should this be an RFC? [Proposal criteria](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/proposals/README.md#L21-L33)
- Should `section_update` take the current slug as `targetSlug` alongside the optional `slug` from the update schema, or use `slug` for the current value and `newSlug` for the replacement? [REST update splits path slug and body](https://github.com/emdash-cms/emdash/blob/01f717df78a544e1033dbf58f6aa8e1f963c3bc5/packages/core/src/astro/routes/api/sections/%5Bslug%5D.ts#L46-L66)
