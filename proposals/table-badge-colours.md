---
title: Colour table badges by value
type: feature-plan
status: proposed
authors:
  - Ronald (@saariuslystoned)
discussion: null
created: 2026-11-13
---

# Colour table badges by value

## Problem and user case

A Block Kit `table` column with `format: "badge"` always draws Kumo's default badge: white text on a black pill. A plugin can't signal what a status means, so every row looks equally urgent.

We hit this building the Shipments page of a shipping plugin. Its order list shows statuses such as Needs label, Fix address, In transit, Delivered and Label cancelled, and every one gets the same black pill. Store owners expect the colour coding that Shopify and WooCommerce give order statuses: yellow when the order waits on them, red when something needs fixing, green when it arrived. Plugins work around it today with emoji dots in plain-text columns, which reads unevenly and drops the badge shape.

Kumo's `Badge` already has `success`, `warning`, `error`, `info` and neutral variants. Block Kit just has no way to choose one.

## Proposed behavior

A `badge` column can carry `badge_variants`: a map from a cell's exact text to a colour. A cell whose text has an entry gets that colour. Any other cell keeps today's default badge.

```json
{
	"type": "table",
	"page_action_id": "list",
	"columns": [
		{ "key": "order", "label": "Order" },
		{
			"key": "status",
			"label": "Status",
			"format": "badge",
			"badge_variants": {
				"Needs label": "warning",
				"Fix address": "error",
				"In transit": "info",
				"Delivered": "success",
				"Completed": "neutral"
			}
		}
	],
	"rows": [
		{ "order": "#1012", "status": "Needs label" },
		{ "order": "#1009", "status": "Delivered" }
	]
}
```

The colours are semantic names, not Kumo class names, so Block Kit stays independent of the component library:

| `badge_variants` value | Kumo `Badge` variant |
| ---------------------- | -------------------- |
| `neutral`              | `secondary`          |
| `info`                 | `info`               |
| `success`              | `success`            |
| `warning`              | `warning`            |
| `error`                | `error`              |

Rows stay plain strings, so sorting, paging and agents reading the table work exactly as they do now.

## Goals

- Let a plugin colour each badge in a table by its value, using Block Kit alone.
- Keep the change additive: existing tables and rows render exactly as they do today.
- Use semantic colour names that follow Kumo's light and dark themes.

## Non-goals

- Badges outside tables (on `header`, `section` or `context`). That would be a separate proposal.
- Arbitrary colours or hex values.
- Per-row variant objects in place of plain cell strings.

## Interfaces and compatibility

Additive, in `@emdash-cms/blocks`:

- `TableColumn` gains an optional `badge_variants?: Record<string, TableBadgeVariant>`.
- A new exported type: `TableBadgeVariant = "neutral" | "info" | "success" | "warning" | "error"`.
- `validateBlocks` accepts the field only on a `badge` column.
- The table renderer passes the mapped Kumo variant to `Badge`.

There is no change to stored data or configuration. An older admin that doesn't know the field ignores it and draws default badges, so a plugin that sends it still renders correctly there.

## Errors and edge cases

- `badge_variants` on a column whose format isn't `badge`: validation error at `columns[i].badge_variants`.
- A value that isn't an object, or a colour outside the five names: validation error naming the allowed values.
- More than 50 entries in one column: validation error, which keeps responses within the existing size limits.
- Matching is by exact text, case-sensitive. Keys are checked with `Object.hasOwn`, so names like `constructor` never pick up inherited properties.
- A non-string cell is turned into text the same way the badge already formats it, then looked up.

## Verification

- Validation tests: a valid map passes. A map on a non-badge column, an unknown colour, and a non-object value each fail at the right path.
- Renderer tests: mapped values get the matching variant, and unmapped values get the default badge.
- Manual check in the admin, light and dark: a plugin page table showing each colour.

A prototype is in `table-badge-variants.patch` (based on `c73c600`). It passes `@emdash-cms/blocks`'s 171 Vitest tests, which include two new validation tests and one new renderer test, and `tsc --noEmit` on the package. Screenshots of a real plugin page in the EmDash 1.4.0 admin, before and with the prototype renderer, are attached.

## Open questions

- Is a feature plan enough, or do Maintainers want an RFC because `badge_variants` extends the plugin-facing Block Kit surface? It is additive, optional, and ignored by older admins.
- Should a `context` or `header` badge follow, with the same colour names?

---

_AI disclosure: drafted with Claude (Anthropic) in Claude Code, including the prototype code and tests. Reviewed and submitted by Ronald._
