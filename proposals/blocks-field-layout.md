---
title: "Blocks field: content-first field layout"
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-14
---

# Blocks field: content-first field layout

This is the second of three plans for the admin's `blocks` field. It covers how the fields inside an open block are laid out and validated. It builds on [Blocks field: scannable block list](blocks-field-block-list.md), and a third plan covers lists (repeaters) inside blocks.

## Problem and user case

Opening a block shows each of its fields as a labelled, bordered box in one column, in the order the block type defines them. The marketing template's Hero block has 12 fields, and the form gives the editor little help reading them:

- The headline looks like every other field, so the form doesn't show what the block says.
- Every `text` field is a 10-row box with the placeholder "Enter markdown content...". A one-sentence subheadline takes the height of a paragraph.
- A button's text and its link are two separate full-width boxes. The Hero has three of these pairs: primary button, secondary button and announcement.
- Block fields have no help text, so the marketing seed writes instructions into labels, such as "Primary button link (starts with /, https://, mailto:, tel: or #)". Long labels wrap and push fields apart.
- Settings such as "Center the layout" and "Section ID" get the same weight as the headline.
- The admin doesn't check block fields before saving. An empty required field only shows up when the server rejects an autosave.

## Proposed behavior

Try it in the [interactive mockup](https://emdash-blocks-field-mockup.gifted-paperback.workers.dev/?site=halden&notes=on), where the Hero block starts open. Notes 5, 10, 11, 14 and 15 cover this plan. The mockup's toolbar also shows the two layouts that were considered and rejected: labels beside every field, and labels above every field.

In this plan, a **link field** is a `url` field, or a `string` field whose slug ends in `_url`, `_link` or `_href`. The marketing seed's button links are `string` fields of this kind.

### Three parts, top to bottom

An open block shows its content first, then its settings, then an Advanced row.

1. **Content.** One-line text (`string`), text areas (`text`), rich text and photos run full width, each under a small label.
   - The block's headline reads as a heading, in larger semibold text. It's the first `string` or `text` field whose slug or label contains the word headline, heading, title or statement. A field whose slug or label contains the word label, eyebrow, kicker or tag is never the headline. Words match whole, with slugs split at underscores and labels at spaces and punctuation, so "subheadline" and "subtitle" don't count. When no field matches, the block's first `string` or `text` field is the headline, unless it's one of the excluded fields.
   - Two or three `string` fields in a row share a line, such as a pricing plan's Price and Period. They stack on narrow screens.
   - Photos span the block, with Replace and Remove on hover. A field named `{image}_caption` sits under its photo as the caption.
   - Text areas start one line tall and grow as you type.
   - Until the lists plan replaces it, a list keeps today's repeater editor, full width in this part.
2. **Settings.** Rows under a thin divider, each with its label at the start and its value at the end.
   - A button's text and its link share one row. Fields pair by name: `{base}_label`, `{base}_text` or `{base}` with `{base}_url`, `{base}_link` or `{base}_href`. The row is labelled with the text field's label minus a trailing "text", so "Primary button text" becomes "Primary button".
   - Switches, choices, numbers, dates, files, and link fields that aren't in a button row get one row each.
   - When the field is narrower than 440 px, each settings row puts its label above its value.
3. **Advanced.** A closed row at the end holds the section ID (`anchor_id`) and shows its value while closed.

Values stay quiet until you reach for them: no box at rest, a light fill on hover and a focus ring while editing. A field with a maximum length shows a character count while you type.

| Field type          | Shown as                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `string`            | One-line text in the content part; a link field gets a settings row   |
| `text`              | Growing text area in the content part                                 |
| `portableText`      | The existing rich text editor, full width in the content part         |
| `image`             | Full-width photo in the content part                                  |
| `url`               | Settings row, or the link half of a button row                        |
| `boolean`           | Settings row with a switch                                            |
| `select`            | Settings row with a dropdown                                          |
| `multiSelect`       | Settings row with today's checkboxes                                  |
| `number`, `integer` | Settings row with a number input                                      |
| `datetime`          | Settings row with today's date and time input                         |
| `file`              | Settings row with today's file control                                |
| `repeater`          | Today's repeater editor, full width, until the lists plan replaces it |

The mockup's sample pages don't use `multiSelect`, `datetime` or `file` fields, so those rows aren't shown there.

### Hints from labels

When a label ends in parentheses that contain a space, or in ", for example …", that part becomes the field's hint. "Primary button link (starts with /, https://, mailto:, tel: or #)" becomes the label "Primary button link" with the hint "Starts with /, https://, mailto:, tel: or #". Parentheses without a space stay in the label, so "Price (USD)" and "Size (px)" keep their units.

A hint shows:

- as the placeholder of an empty optional field, so "Checklist (one item per line)" reads "One item per line" until you type. The two halves of a button row keep their "Text" and "Link" placeholders instead;
- under the field while you type in it;
- as the error under a field whose value doesn't match the field's pattern.

### Validation

- The admin checks block fields with the same rules the server applies:
  - a required field can't be missing or empty;
  - a value must match its field's pattern, length limits, number range and options, and a `url` value must be a safe link;
  - a list must stay within its `minItems` and `maxItems`;
  - a required sub-field of a list item can't be missing or empty.
- These are checks on the data, so they cover every field, including lists drawn by today's repeater editor. They never reject a value the server accepts: a value made only of spaces counts as filled, as it does on the server.
- A new block's switches start off, so a required switch is never missing.
- An empty required field reads "Required". After you leave it, or when you save or publish, it turns red. An empty required photo shows its empty state in red.
- A field whose value doesn't match its pattern shows its hint, or "Check the format" when it has none, as an error under the field.
- A list with too few or too many items shows the error under its label. The mockup doesn't show this error.
- A closed block with an invalid field gets a red dot. Save and Publish open the first such block and focus the field.
- While a block field is invalid, autosave waits, as it does today for invalid URLs. A notice says autosave is paused and names the block and field. Clicking it opens the block and focuses the field, as Save does. Autosave resumes once the field is fixed, so a newly added block with an empty required field holds autosave until it's filled in.
- A newly added block shows no red errors until you touch one of its fields or save.

### Right-to-left languages

Labels sit at the start, on the right, and values line up with their labels, even when the text in a value runs left to right.

## Goals

- An editor can read what a block says from its open form, in the order the page shows it.
- Related fields sit together: a button's text with its link, and a photo with its caption.
- Instructions appear where they're needed: in the empty field, and under the field while typing.
- Invalid block fields, including list sizes and list items, are caught before autosave sends them, with the field and block marked.
- Every existing block type works without a schema change. Fields that don't follow the naming conventions fall back to plain rows.
- Everything works with a keyboard, a screen reader, right-to-left languages, phone screens and dark mode.

## Non-goals

- Explicit layout settings on block fields, such as help text, groups or widths. They would change the block type schema and the API, so they need an RFC. The name-based rules in this plan would stay as the fallback for fields without settings.
- Letting drafts save blocks with empty required fields. The server rejects them on every save, and changing that is an API change for its own proposal.
- The same layout for top-level collection fields.
- Lists inside blocks, which the third plan covers.
- A live preview beside the form.

## Interfaces and compatibility

- No changes to stored data, the API or the block type schema. The admin computes the layout from each field's existing `type`, `slug`, `label`, `required` and `validation`.
- Field names and label words become layout signals: the pairing suffixes, `{image}_caption`, `anchor_id`, the headline words and label hints. The blocks guide (`docs/src/content/docs/guides/blocks.mdx`) gets a short section listing them as best-effort layout hints that may change, so developers can choose names that lay out well without treating them as a contract.
- Inside blocks, `BlocksField` places each nested field (content, settings row or Advanced) and asks the editor's field renderer for a quiet control without its own label. Top-level fields keep their current look. The `renderField` callback between `ContentEditor` and `BlocksField` is internal to `@emdash-cms/admin`.
- Quiet controls are the existing Kumo components and field controls with token-based class overrides: transparent border and background at rest, a fill on hover and a ring on focus. Kumo has no borderless input variant; the overrides can go if it gets one.
- Holding autosave for invalid block fields reuses the existing check that holds it for invalid URLs.
- The implementation ships with an `@emdash-cms/admin` changeset.

## Errors and edge cases

- **Names that match no convention:** no button row, caption or Advanced row. Each field gets its own row, and nothing is hidden.
- **A unit or code in parentheses:** only parentheses that contain a space are split, so "Price (USD)", "Size (px)" and "Aspect ratio (16:9)" stay whole.
- **Labels in other languages:** parentheses split the same way. ", for example" and the headline words are only recognized in English. In other languages that text stays in the label, and the first-field rule picks the headline.
- **No headline candidate:** a block that starts with "Section label", such as Testimonials, has no field styled as a heading.
- **Half-filled button row:** the empty half shows its placeholder, "Text" or "Link".
- **Long values in settings rows:** cut off with an ellipsis until focused.
- **Unsupported field types:** keep the existing unsupported message.
- **Narrow fields:** below 440 px, settings rows stack their labels above their values, and side-by-side `string` fields stack too.
- **Read-only:** the same layout with controls disabled, and no validation markers.

## Verification

Unit tests for the layout rules: button pairs for every suffix combination, captions, the Advanced row, headline selection with whole-word matching ("subheadline" isn't a headline, "Section label" is excluded), and hint splitting, including "(USD)" staying whole.

Unit tests for the client checks: a missing and an empty required value for each field type, patterns, list `minItems` and `maxItems`, required sub-fields, and a value made only of spaces passing.

Browser tests, extending `packages/admin/tests/components/BlocksField.layout.test.tsx`:

- An open Hero shows the headline as a heading, then the subheadline, then the photo and its caption, then the settings rows, and the section ID inside a closed Advanced row.
- Fields whose names match no convention render as separate rows.
- A hint shows as the placeholder of an empty optional field, under the field while focused, and as the error when the field fails its pattern. Button rows keep "Text" and "Link".
- Text areas grow with their content.
- A required field turns red after blur and on Save, and a fresh block shows no errors.
- An invalid block field holds autosave and shows a notice naming the block and field. Clicking the notice opens the block and focuses the field, and fixing the field resumes autosave.
- Save with an invalid field in a closed block opens that block and focuses the field.
- In right-to-left mode, values line up with their labels.
- Below 440 px of field width, settings rows stack.

Manual checks on the marketing template's Home page: desktop at 1280 and 1440 px, phone width at 375 px, Arabic, dark mode, keyboard only, and a screen reader. The screen reader check covers that quiet controls keep their labels and that hints and errors are announced through `aria-describedby`.

## Implementation

One implementation pull request, stacked on the block list one. It changes `BlocksField.tsx` (layout rules, rows and validation), `ContentEditor.tsx` (quiet controls for nested fields and the autosave check), their tests, and the blocks guide.

## Open questions

- Should name-based layout stay the long-term approach, or should block fields get explicit `description` and `group` settings through an RFC? Recommendation: ship the name-based rules now. They need no schema change, and they would remain the fallback if settings arrive later.
- Should an empty required field turn red when you leave it, or only when you save? Recommendation: when you leave it, as in the mockup, but never on a block nobody has touched.
