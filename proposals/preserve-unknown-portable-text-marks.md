---
title: Edit rich text that contains marks the editor doesn't know
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-11-04
---

# Edit rich text that contains marks the editor doesn't know

## Problem and user case

Portable Text lets a site store any inline mark: a bare decorator such as `cg-rosa`, or an annotation whose `markDefs` entry holds data, such as `{ "_type": "lang", "lang": "es" }`. The site renders these marks through the `marks` components it passes to `<PortableText>`. The rich text editors in EmDash know a fixed set: strong, emphasis, underline, strike-through, subscript, superscript, inline code, and links.

Since the fix for [#2430](https://github.com/emdash-cms/emdash/issues/2430), a field that contains any other mark can't be edited. The admin shows "This content cannot be edited safely" in place of the editor and blocks saving, and the visual inline editor refuses the field too. That protects the content, but it locks editors out of it.

This mostly hits sites that came from another CMS. In [#3168](https://github.com/emdash-cms/emdash/issues/3168), a site migrated from WordPress and Elementor has custom decorators in 154 of its 206 entries, so editors can't change the text of three quarters of the site. That site carries a patch to `@emdash-cms/admin`. Another keeps a fork for imported text colors, and a third needs `lang` annotations for accessibility.

#3168 asks for a plugin API that registers new marks. That API is a larger design: trusted code in two editors, toolbar controls, validation, and rendering. This plan solves the part that blocks people today: editing the text around marks the editor doesn't know, without losing them.

The decision on #2430 split the work the same way: opening and saving must never silently remove a mark, and a mark registration API is separate. This plan keeps that rule and replaces "block the save" with "keep the mark" wherever the editor can keep it exactly.

## Proposed behavior

The admin's rich text editor and the visual inline editor open fields with unknown marks and keep those marks through edits and saves.

- Text with an unknown mark gets a subtle background in the editor, using a Kumo token, so it doesn't look like underline or a link. The editor doesn't show what the mark means on the site.
- A notice above the field names the marks and explains that they are kept: "This field contains formatting the editor can't show: cg-rosa, lang. It is kept when you save." For an annotation, the notice shows its `_type`. The notice replaces today's error, and saving and autosave work as usual.
- Editors change text inside and around a marked range as they change other formatted text. Typing inside the range extends the mark; typing at either edge doesn't.
- Typing over a selection that lies entirely inside one marked range keeps the mark, so fixing a typo in a marked word doesn't remove it. Deleting all of a range's text deletes its mark.
- Editors can't create unknown marks. No toolbar button, shortcut, or slash command adds one. Pasted content keeps an unknown mark only when the field already contains the same mark, with the same name and the same definition. Copying a marked phrase within a field keeps it; pasting from another site never creates one.

Opening a field and leaving it unchanged saves nothing, as today. Changing the text keeps each mark's name and its `markDefs` entry. The admin editor also keeps span and annotation keys; the visual inline editor keeps annotation keys and, as today, writes new span keys.

Worked example. The stored block:

```json
{
	"_type": "block",
	"_key": "b1",
	"style": "normal",
	"markDefs": [{ "_key": "l1", "_type": "lang", "lang": "es" }],
	"children": [
		{ "_type": "span", "_key": "s1", "text": "The term ", "marks": [] },
		{ "_type": "span", "_key": "s2", "text": "infracción grave", "marks": ["l1", "strong"] },
		{ "_type": "span", "_key": "s3", "text": " is ", "marks": [] },
		{ "_type": "span", "_key": "s4", "text": "rosa", "marks": ["cg-rosa"] }
	]
}
```

An editor changes "The term" to "This term" and saves. The first span's text changes. `s2` keeps both marks, written as `["strong", "l1"]` because the editor lists built-in marks first. `s4` keeps `cg-rosa`, and `markDefs` keeps `l1` unchanged.

## Goals

- Editors can open and edit fields whose only obstacle is a well-formed mark the editor doesn't know, in the admin and in the visual inline editor.
- Unknown decorators and annotations survive the editors' conversions, edits, saves, autosave, and inserted sections, with their names and `markDefs` data.
- Editors can see which text carries such a mark.
- No editor conversion silently drops a mark. Content the editors can't keep exactly stays blocked, as today.

## Non-goals

- Applying, changing, or removing unknown marks through editor controls.
- A plugin or configuration API that registers marks with their own controls and rendering. That is the rest of #3168 and needs its own proposal. A registered mark would take precedence over the handling described here. Marks no registration claims, including those of a missing or disabled plugin, keep this handling instead of the block that #3168's acceptance criteria assume; a registry can still block marks it knows but finds invalid.
- Showing a mark in the editor as the site renders it, for example in its colour.
- Validating the data inside an unknown annotation. The editor neither reads nor changes it.
- Unknown marks inside tables. Table cells keep today's rules, and a field whose unknown marks are in a table stays blocked.
- Other lossy normalizations the editors already apply, such as unknown block styles. They are unchanged.
- A site-configured allowlist of mark names, as suggested in #3168. Keeping every well-formed mark needs no configuration and helps sites that don't know which marks an import produced.
- Changing how sites render Portable Text. Stored content doesn't change.

## Interfaces and compatibility

- **Stored data.** None. Content keeps the Portable Text shape it already has.
- **Editor schema.** Both editors gain one internal TipTap mark, `emdashPortableTextUnknownMark`, next to the existing `emdashPortableTextSpan` identity mark. Each unknown mark on a span becomes one instance with two attributes:
  - `name`: the string in the span's `marks` array, such as `"cg-rosa"`, or the key `"l1"` for an annotation;
  - `markDef`: the referenced `markDefs` entry, copied unchanged, or `null` for a bare decorator. For an annotation, this attribute is the source of truth when the span is saved.

  The mark is inclusive inside its range but not at its edges, and uses `excludes: ""` so several unknown marks and every built-in mark can share a range. It renders as a `<span>` with a `data-emdash-unknown-mark` attribute that holds the name and definition as JSON, set as an attribute value and never spread into other attributes.

- **Paste.** The mark's `parseHTML` rule reads that attribute, so copying within EmDash editors works. A paste rule then keeps a pasted unknown mark only if the target document already has a mark with the same name and a deeply equal definition, and removes every other pasted unknown mark. An attribute that isn't valid JSON, is larger than 16 KB, nests deeper than 16 levels, names a built-in mark, or has a definition whose `_type` is `link` creates no mark. The notice is derived from the current document, so it stays accurate after pastes and deletions.
- **Converters.** The core converters (`portableTextToProsemirror` and `prosemirrorToPortableText`), the admin editor's copies, and the visual inline editor's copies convert a well-formed mark that isn't built in to this mark, and convert it back to the same name and definition. Every converter's fallback for a mark it doesn't recognize throws `UnsupportedPortableTextMarksError`. That includes the visual inline editor's, which today writes the ProseMirror mark type as a decorator, or silently drops an unknown mark when no check ran first.
- **Mark safety.** `findUnsupportedPortableTextMarks` and the ProseMirror check stop reporting the marks the editors now keep. They keep reporting everything listed as blocked under Errors and edge cases, and the existing error and save block stay in place for those.
- **Visual inline editor.** Today it shows a hard-coded English error and refuses the field. It shows the same notice as the admin instead, and its save error stays for blocked content.
- **Exported API.** `portableTextIdentityExtensions` gains the new mark. `portableTextToProsemirror` with `{ preserveIdentity: true }` returns the mark instead of throwing; without it, it throws as today, because callers who didn't add the extensions have no schema for the mark. `prosemirrorToPortableText` converts the mark back whenever it appears. `getHTML()` on an editor built with these extensions includes the data attribute.
- **Trusted editor panels.** The pending [Draft access for trusted editor panels](trusted-editor-panel-drafts.md) RFC validates rich text patches with `findUnsupportedPortableTextMarks()` and `portableTextToProsemirror()`. Under this plan, those checks accept well-formed unknown marks, so a panel can write content with them, as the API already can. That RFC needs no text change, because it defines the check by these functions; this pull request names the effect so both reviews see it.
- **Plugins.** No plugin API change. Plugin blocks are unaffected.

Content that opened before still opens the same way. Content that was blocked now opens, unless it falls under one of the cases below.

## Errors and edge cases

These cases stay blocked as today, with the error naming what the editor can't keep:

- a span's `marks` is not an array, or contains something other than a string;
- a block has two `markDefs` entries with the same `_key`;
- a span references a definition whose `_type` is not a string;
- an unknown mark sits on a span that is empty or holds only line breaks, since the editor has no text to carry it;
- an unknown mark is inside a table.

Other cases:

- **Definition missing.** A span lists a name with no matching `markDefs` entry, such as data from a broken import. It's kept as a bare decorator: `markDef` is `null`, and the name is written back unchanged.
- **Built-in names.** A bare decorator named like a built-in mark, such as `strong`, is that built-in mark. A definition with `_type: "link"` stays a link.
- **Unused definitions.** `markDefs` entries no span references are dropped on save, as today.
- **Key collisions.** Joining blocks, dragging text, or inserting a section can bring two annotations with the same key into one block. Identical definitions share the key. When the definitions differ, or the key matches a link or a bare decorator in the block, the second annotation gets a new key. Links are unchanged by this plan.
- **Order.** The editor sorts a text's marks by type, so a saved span lists built-in marks first, then unknown marks in their original order. The Portable Text renderer orders nested marks itself, so this doesn't change the rendered site.
- **Merged and split spans.** Spans the editor merges keep the first key. Splitting a span gives the new part a new key and the same marks.
- **Inline code.** Inline code combines with unknown marks as it does with links.
- **Cost.** Converting a document on each change does work proportional to its marks, as it already does for links.

## Verification

- Converter unit tests, run through one shared fixture against the core converters, the admin editor, and the visual inline editor:
  - round trips for bare decorators, annotations with nested data, several unknown marks on one span, and unknown marks mixed with every built-in mark and links;
  - a missing definition, and every blocked case listed above;
  - key collisions from joined blocks, dragged text, and inserted sections;
  - an unchanged document converts back equal to its input, apart from mark order;
  - `portableTextToProsemirror` without `preserveIdentity` still throws.
- Mark safety tests: kept marks no longer report, and every blocked case still does.
- Admin browser tests:
  - a field with unknown marks opens, shows the notice and the highlight, accepts edits around and inside a marked range, autosaves, and saves the expected Portable Text;
  - typing over a selection inside a marked range keeps the mark, and deleting the range's text removes it;
  - copying a marked phrase within a field keeps it; pasting a mark that isn't in the field, invalid or oversized attribute data, or a `link` definition creates none, and the notice updates;
  - a field whose unknown marks are in a table stays blocked;
  - revision previews of older content with unknown marks open;
  - the notice in Arabic keeps mark names left to right.
- Visual inline editor browser test: editing and saving text next to an unknown mark keeps it.
- A script that converts every rich text field of a migrated site's content to the editor format and back, and reports any difference other than mark order. The site from #3168 has offered to test against its content.

## Open questions

- Should the editor show a mark's name on hover or focus, so editors can tell `cg-rosa` from `cg-w400`? A screen reader hint is part of the same question.
- Should sites be able to map unknown marks to an admin CSS class, so the editor can show them closer to the site? That could be a later configuration option without changing what this plan stores.
- Maintainers: is a feature plan the right process? The change is additive and keeps the #2430 rule that no save removes a mark, but it touches the exported converters and two packages, which the proposal guide lists as RFC triggers.
