---
title: Percent change format for Block Kit table columns
type: feature-plan
status: proposed
authors:
  - Chiji1108 (@Chiji1108)
discussion: null
created: 2026-11-10
---

# Percent change format for Block Kit table columns

## Problem and user case

A plugin admin page that compares two periods shows each row's change from the previous period. An analytics plugin, for example, lists pages with their views and how much those views rose or fell. Readers scan such a list for what grew and what dropped, so analytics dashboards usually show increases in green and decreases in red.

A Block Kit table cannot show this today. `TableColumn.format` accepts `text`, `badge`, `relative_time`, `number`, `code` and `element`, and none of them colors a value. A plugin has to write the change as text, such as `↑ 150.0%` or `↓ 20.0%`. The text renders in the default color, and the plugin formats the percentage itself in one fixed locale instead of the viewer's.

The `stats` block already colors trends, with `text-green-600` for `up` and `text-red-600` for `down`. Tables have no equivalent.

## Proposed behavior

A column with `format: "percent_change"` takes a number in each row: the change as a ratio, where `0.25` means 25% higher and `-0.1` means 10% lower. The admin renders it as a signed percentage in the viewer's locale with an arrow:

| Cell value | Rendered | Color |
| --- | --- | --- |
| `0.25` | ↑ +25% | green, as in the `stats` block's `up` trend |
| `-0.1` | ↓ -10% | red, as in the `stats` block's `down` trend |
| `0` | 0% | `text-kumo-subtle`, no arrow |
| `null` or absent | empty cell | — |
| `"New"` | New | default text color |

```ts
{
	type: "table",
	page_action_id: "pages",
	columns: [
		{ key: "path", label: "Page", format: "code" },
		{ key: "views", label: "Views", format: "number" },
		{ key: "change", label: "Change", format: "percent_change" },
	],
	rows: [
		{ path: "/", views: 1200, change: 0.25 },
		{ path: "/about", views: 300, change: -0.1 },
		{ path: "/careers", views: 40, change: "New" },
	],
}
```

The percentage uses `Intl.NumberFormat` with the browser's default locale, as the `number` format does with `toLocaleString()`. It shows at most one fractional digit, so `0.1234` renders as `+12.3%`.

A string value renders as plain text, as the `number` format does for a value that is not a number. This lets a row state why it has no comparison, for example `New` for a page that had no views in the previous period. A plugin that has nothing to say leaves the value `null`.

## Goals

- Let a plugin show a change between two values in a table without formatting the number or picking colors itself.
- Match the colors and arrows that the `stats` block uses for trends, so tables and stats read the same way.
- Format the percentage in the viewer's locale.
- Keep the change direction readable without color: the arrow and the sign carry it as well.

## Non-goals

- Treating a decrease as the good direction, as for error counts or load times. Every positive value renders green. An option such as `invert` can be added later without changing this format.
- Absolute changes such as `+120 views`. The format shows a ratio as a percentage only.
- Sorting. Tables sort through the plugin's `page_action_id` handler, which sees the raw values, so this format needs no sorting changes.
- Changing the `stats` block.

## Interfaces and compatibility

- `TableColumn.format` in `@emdash-cms/blocks` gains the value `"percent_change"`. The change is additive: existing columns render as before.
- Block validation accepts the new value. It does not validate row values, as for the other formats.
- A plugin that uses the format on an EmDash release without it fails validation, because the format value is unknown there. Plugins that support older releases can keep writing text until they require a release with the format.
- The Block Kit plugin reference and the creating-plugins skill list the new format.

No stored data, configuration, or runtime API changes.

## Errors and edge cases

- `NaN`, `Infinity` and `-Infinity` render as an empty cell. A plugin that divides by a previous value of zero gets `Infinity`. It should send `null` or a string such as `New` for that row.
- A value that rounds to zero at one fractional digit, such as `0.0004`, renders as `0%` in the muted color, so the sign, arrow and color always agree with what the reader sees.
- A boolean or object renders as text, as for the other formats.

## Verification

- Renderer tests cover a positive, negative, zero, near-zero, `null`, non-finite and string value: the text, the arrow, and the color class.
- A test confirms the percentage follows the locale through `Intl.NumberFormat`.
- A validation test accepts a `percent_change` column and still rejects an unknown format.
- Manual check in the blocks playground in light and dark mode.

A prototype on the author's fork implements this plan with tests, docs and a playground example: [`feat/blocks-table-percent-change`](https://github.com/Chiji1108/emdash/compare/main...Chiji1108:emdash:feat/blocks-table-percent-change).

## Open questions

- Name: `percent_change` states that the value is shown as a percentage. `change` or `delta` are shorter but leave the unit unclear.
