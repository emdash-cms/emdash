---
title: Readable revision history
type: feature-plan
status: accepted
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-12
---

# Readable revision history

## Problem and user case

Editors open the Revisions panel to answer one question: what changed? They ask it before publishing, after someone else edits a post, and before rolling back.

Right now the panel answers with raw JSON. Rich text shows up as Portable Text blocks, keys, and spans, and editing one word marks the whole field as changed. In a long post, finding the actual edit means reading two JSON dumps side by side.

## Proposed behavior

Clicking a version in the Revisions list shows that version in the editor, read-only. There's no new screen: the canvas and the sidebar stay where they are. You can try it in the [interactive mockup](https://emdash-version-history-mockup.gifted-market-6ca.workers.dev/), which uses made-up content and people.

- Changes are marked in the post. Added text is highlighted and removed text is struck through, in the color of the person who saved that version. The colored dot next to their name in the list doubles as the legend.
- The selected version lists what changed in plain words, like "Changed the title", "Edited “Most teams plan posts in…”", or "Turned on Featured post". Clicking an item scrolls to that change.
- A bar at the bottom of the canvas has Show changes, Back to editing, and Restore. Save and Publish pause while you're looking, and the formatting toolbar hides because there's nothing to format.
- Restore works like it does today: the version becomes the current draft, and the live post doesn't change until someone publishes.
- The list uses plain labels. The newest version reads "Current version" and the live one reads "Published".
- On phones, the list lives in the settings sheet and the bar gets arrows to step between versions.

## Goals

- Show what changed between versions without any JSON.
- Make edits easy to find in long posts.
- Let editors see exactly what a version contains before they restore it.
- Work with a keyboard, screen readers, right-to-left languages, and phone screens.

## Non-goals

- Suggestions or tracked changes with accept and reject.
- Comparing any two versions, or comparing a version with the current draft.
- Named versions, or restoring a single field or block.
- Detailed formatting diffs. A block whose text stayed the same but whose style changed shows as "Changed the style of …".
- Changing when or how revisions are created.

## Interfaces and compatibility

- The revisions list response (`GET /_emdash/api/content/{collection}/{id}/revisions`) gains an `author` field with the author's ID and display name, or `null`. Revisions already store `authorId`, but only admins can look up users, so other roles can't show names today. Existing fields don't change. The name comes from a join on the existing query, so it adds no round trip, and the route keeps requiring `content:read_drafts`.
- No database changes. The admin computes the diff from revision data the list already returns. Blocks are paired by their Portable Text `_key`, and words are split with `Intl.Segmenter`, so languages that don't put spaces between words work too.
- "Published" comes from the entry's existing `liveRevisionId`. "Current version" marks the newest revision.
- Restore keeps using the existing endpoint.
- The JSON diff in the Revisions panel goes away.

## Errors and edge cases

- The first version has nothing to compare with, so it reads "Created this post". If older revisions were pruned (EmDash keeps 50 per entry), the oldest one left reads "Earliest saved version" instead.
- The list loads one revision more than it shows, so the oldest version in the list still has something to compare with.
- The current version has no Restore button.
- Fields the preview can't mark up inline, like references and custom blocks, show up in the change list as "Changed <field label>".
- A version that exactly matches an older one reads "Restored the version from <date>".
- Opening a version doesn't touch unsaved edits. Back to editing returns the editor as you left it.
- If someone else saves while you restore, the restore fails with the existing conflict error and nothing changes.
- Revisions whose author was deleted show "Unknown author".
- Very large blocks are marked as changed as a whole instead of word by word, so the diff stays fast.

## Verification

- Unit tests for the diff: word edits, added and removed blocks, image caption changes, style-only changes, text without spaces (for example Japanese), and the large-block fallback.
- Browser tests: open a version, toggle Show changes, jump to a change, restore, and return with Esc or Back to editing with unsaved edits intact.
- An API test that the list includes author names for non-admin roles and `null` for deleted users.
- A manual pass in light and dark mode, at phone width, in Arabic, and with a screen reader.

## Open questions

- Should the editor header get a clock button as a second way into version history?
- Should author names ship in this change or in a follow-up?
- Do we want shareable links to a specific version, such as `?version=<id>`?
