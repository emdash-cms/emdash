---
"@emdash-cms/admin": minor
---

Updates open blocks in `blocks` fields so the form reads in the order the page shows it, and checks block fields before saving. Every site with a blocks field gets the new layout; stored content, the API, block type schemas and how sites render blocks are unchanged.

- An open block shows its content first: one-line text, text areas, rich text, photos and lists, each under a small label. The block's headline is drawn larger, two or three one-line text fields in a row share a line, a photo's `{image}_caption` field sits under it, and text areas start one line tall and grow as you type.
- Settings follow as rows under a divider, with the label beside the value: switches, choices, numbers, dates, files and links. A button's text and its link share one row, such as `cta_label` and `cta_url`. The section ID (`anchor_id`) waits in a closed Advanced row that shows its value. When the field is narrower than 440 px, each row puts its label above its value.
- Fields have no box until you hover or focus them. A label that ends in parentheses with a space, or in ", for example …", becomes a short label and a hint: "Link (starts with / or https://)" reads "Link", with the hint in the empty field, under the field while you type, and as the error when the value doesn't match the field's `pattern`. "Price (USD)" stays whole.
- The admin checks block fields with the server's rules: required fields, patterns, lengths, number ranges, whole numbers, choices, safe links, list sizes and required list sub-fields. An empty required field reads "Required"; after you leave it, or when you save or publish, it turns red, and a closed block with a problem shows a red dot. A newly added block shows nothing until you leave one of its fields or save. Save and Publish open the first block with a problem and focus the field.
- While a block field has a problem, autosave waits, as it does for an invalid URL, and an "Autosave paused" notice names the block and field. Its Show button opens the block and focuses the field. Autosave resumes with your next change once every problem is fixed. A new block's switches start off, so a required switch is never missing.

The layout follows field types and names. The naming conventions are listed in [Build pages with blocks](https://docs.emdashcms.com/guides/blocks/#name-fields-for-the-editor-layout); a field that matches none of them gets a row of its own. Lists inside blocks keep their current editor.
