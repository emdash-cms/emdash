---
title: Percent change format for Block Kit table columns
type: rfc
status: proposed
authors:
  - Chiji1108 (@Chiji1108)
champion: Chiji1108 (@Chiji1108)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4846
created: 2026-11-10
---

# Percent change format for Block Kit table columns

## Summary

Block Kit table columns gain the format `percent_change`. A cell in such a column holds the change between two values as a ratio, where `0.25` means 25% higher and `-0.1` means 10% lower. The admin renders it as a signed percentage in the viewer's locale with an arrow, green for an increase and red for a decrease, using the colors the `stats` block already uses for trends. A string renders as plain text and `null` leaves the cell empty.

## Problem and user case

A plugin admin page that compares two periods shows each row's change from the previous period. An analytics plugin, for example, lists pages with their views and how much those views rose or fell. Readers scan such a list for what grew and what dropped, so analytics dashboards usually show increases in green and decreases in red.

A Block Kit table cannot show this today. `TableColumn.format` accepts `text`, `badge`, `relative_time`, `number`, `code` and `element`, and none of them colors a value. A plugin has to write the change as text, such as `↑ 150.0%` or `↓ 20.0%`. The text renders in the default color, and the plugin formats the percentage itself in one fixed locale instead of the viewer's.

A sandboxed plugin draws its admin pages only through Block Kit, so it cannot work around this with its own components. [@chiji1108/emdash-plugin-cloudflare-analytics](https://github.com/Chiji1108/emdash-plugin-cloudflare-analytics), a sandboxed plugin that shows Cloudflare Web Analytics, runs into this on two sites that moved from Studio, whose editors expect Studio's colored page list. [Discussion #4846](https://github.com/emdash-cms/emdash/discussions/4846) describes the need. The same applies to any plugin page that compares periods, such as sales, form submissions or search queries.

The `stats` block already colors trends, with `text-green-600` for `up` and `text-red-600` for `down`. Tables have no equivalent.

## Example

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

| Cell value       | Rendered   | Color                                       |
| ---------------- | ---------- | ------------------------------------------- |
| `0.25`           | ↑ +25%     | green, as in the `stats` block's `up` trend   |
| `-0.1`           | ↓ -10%     | red, as in the `stats` block's `down` trend   |
| `0`              | 0%         | `text-kumo-subtle`, no arrow                |
| `null` or absent | empty cell | —                                           |
| `"New"`          | New        | default text color                          |

A prototype on the author's fork implements this design with tests, docs and a playground example: [`feat/blocks-table-percent-change`](https://github.com/Chiji1108/emdash/compare/main...Chiji1108:emdash:feat/blocks-table-percent-change).

## Goals

- Let a plugin show a change between two values in a table without formatting the number or picking colors itself.
- Match the colors and arrows that the `stats` block uses for trends, so tables and stats read the same way.
- Format the percentage in the viewer's locale.
- Keep the change direction readable without color: the arrow and the sign carry it as well.

## Non-goals

- Treating a decrease as the good direction, as for error counts or load times. Every positive value renders green. See [Open questions](#open-questions).
- Absolute changes such as `+120 views`. The format shows a ratio as a percentage only.
- Sorting. Tables sort through the plugin's `page_action_id` handler, which sees the raw values, so this format needs no sorting changes.
- Changing the `stats` block.

## Detailed design

### Public API

`TableColumn.format` in `@emdash-cms/blocks` gains the value `"percent_change"`:

```ts
format?: "text" | "badge" | "relative_time" | "number" | "percent_change" | "code" | "element";
```

The value in each row is a `number` holding the ratio, a `string`, or `null`.

### Rendering

The table renderer formats a finite number with `Intl.NumberFormat` and the browser's default locale, as the `number` format does with `toLocaleString()`:

```ts
new Intl.NumberFormat(undefined, {
	style: "percent",
	maximumFractionDigits: 1,
	signDisplay: "exceptZero",
});
```

So `0.1234` renders as `+12.3%` in English and `+12,3 %` in German. The direction comes from the value rounded to the same digit as the label, so a value shown as `0%` is never colored as a rise or fall:

- a positive rounded value renders green (`text-green-600`) with an up arrow;
- a negative rounded value renders red (`text-red-600`) with a down arrow;
- zero renders in `text-kumo-subtle` without an arrow.

The arrows are the Phosphor `ArrowUp` and `ArrowDown` icons the `stats` block uses, marked `aria-hidden`. Screen readers read the signed percentage, which carries the direction, so the color and arrow are not the only cue.

A string renders as plain text in the default color, as the `number` format does for a value that is not a number. This lets a row state why it has no comparison, for example `New` for a page that had no views in the previous period. `null`, a missing value and a non-finite number render an empty cell. A boolean or object renders as text, as for the other formats.

### Validation

Block validation accepts `"percent_change"` as a column format. As for the other formats, it does not check row values: the renderer handles every value type.

### Localization and accessibility

The renderer adds no translatable strings. The number format follows the browser locale. The green and red classes are the ones the `stats` block uses in light and dark mode.

## Compatibility and migration

The change is additive. Existing columns render as before, and no stored data changes.

A plugin that uses the format on an EmDash release without it fails: the runtime validates sandboxed plugin responses with `validateBlockResponse`, rejects the unknown format value, and the page shows `INVALID_BLOCK_RESPONSE` (HTTP 502). A plugin that supports older releases keeps writing text until it requires a release that includes the format.

`@emdash-cms/blocks` is in the fixed release group with `emdash` and `@emdash-cms/admin`, so the type, validation and renderer ship together. The change is a `minor` release.

Rollback removes the value from the union. Plugins that adopted it would then fail validation as on older releases, so removal after release would be a breaking change.

## Security and privacy

No additional security or privacy surface. Row values come from the plugin and are already untrusted input. The renderer reads a number and passes it to `Intl.NumberFormat`, or renders a string as a React text node, so no plugin value reaches HTML, CSS or a URL. The existing Block Kit response limits on size, depth, node count and string length still apply.

## Performance

`Intl.NumberFormat` runs once per cell in the column. Tables are bounded by the existing response limits, such as at most 1,000 array items. Creating a formatter per cell at that scale is not measurable on page render. If profiling shows otherwise, the renderer can create one formatter per table render.

## Failure handling

There is nothing to retry or recover. Values the renderer cannot format render as an empty cell or as text, and never throw. A plugin that divides by a previous value of zero gets `Infinity`, which renders empty. Such a plugin should send `null` or a string such as `New` for that row.

## Verification

- Renderer tests cover a positive, negative, zero, near-zero, `null`, non-finite and string value: the text, the arrow, and the color class.
- A test confirms the percentage follows the locale through `Intl.NumberFormat`.
- A validation test accepts a `percent_change` column and still rejects an unknown format.
- Manual check in the blocks playground in light and dark mode.

The prototype includes these tests, and they pass.

## Rollout and implementation

One implementation pull request adds the type, validation, renderer, tests, the Block Kit docs section, the creating-plugins skill reference, a playground example and a changeset. No feature flag is needed, because nothing changes until a plugin uses the format.

## Alternatives

- **Text arrows in a `text` column.** This works today but cannot color the value or localize the number. It is the current workaround.
- **A generic tone for any cell**, such as a cell object `{ value, tone: "positive" | "negative" | "neutral" }` or a per-row style. It would cover more cases, such as coloring a status or an absolute change, and let a plugin mark a decrease as good. But it changes the row data shape from plain values to objects, leaves number formatting to the plugin, and needs rules for how a tone combines with each format. A dedicated format keeps rows as plain values and formats the number for the viewer.
- **A `trend` option on the existing `number` format.** Reusing `number` with a column option such as `trend: true` would avoid a new format value, but it mixes two display modes under one name, and the cell would still need a way to say the value is a ratio.

## Drawbacks

- One more format value for plugin authors to learn, and one more to keep stable.
- Colors are fixed: positive is always green. A plugin showing a metric where a decrease is good cannot use the format as intended until an option such as `invert` exists.

## Open questions

- Name: `percent_change` states that the value is shown as a percentage. `change` or `delta` are shorter but leave the unit unclear.
- Whether to add a column option such as `invert: true` now for metrics where a decrease is good, or leave it to a later RFC.
- Whether maintainers prefer the generic cell tone in [Alternatives](#alternatives) over a dedicated format.
