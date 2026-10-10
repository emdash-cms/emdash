---
title: View and edit taxonomy definitions in the admin
type: feature-plan
status: proposed
authors:
  - Ondřej Varga (@onvarga)
discussion: null
created: 2026-10-10
---

# View and edit taxonomy definitions in the admin

## Problem and user case

A site editor can create a taxonomy and delete it from its admin screen, but cannot inspect and edit the definition after creation. The pencil icons edit individual terms. Renaming a taxonomy's display label, changing hierarchy or changing its associated collections requires the API or MCP.

This arose while managing a real EmDash site. A prototype was built, deployed to the site's DEV environment and tested by its owner before proposing the change.

## Proposed behavior

Add **Edit taxonomy** to the existing taxonomy actions menu for built-in and custom taxonomies. Open a dialog with one **Label**, the saved **Identifier** as a disabled input, **Hierarchical**, and associated **Collections**, in the same main field order as creation.

For example, an editor opens `genre`, changes its label from “Genres” to “Reading genres”, saves and reopens the dialog. The new label persists and the page heading, sidebar and selectors refresh. The identifier stays `genre` and term assignments remain intact.

Users who can reach this admin surface and have `taxonomies:read` can inspect the definition. Users with `taxonomies:manage` can save changes. Reuse the existing server permissions and update endpoint.

The label belongs to the actual loaded locale. Hierarchy and collections are shared across locales. Show both scopes beside the fields. If the single-resource GET returns a fallback definition, show its actual locale and save the label explicitly in that locale.

Keep one Label field, matching creation, and preserve any stored `labelSingular` value used by other controls. Send only changed fields, including explicit `false` and `[]` when chosen. Refresh the definition, definition lists, manifest and affected editor queries after a successful save.

## Goals

- Inspect a saved taxonomy definition and edit the existing API-supported fields through the admin.
- Preserve term identities, slugs, assignments and parent relationships.
- Keep current term editing, translation, ordering and deletion available.
- Provide complete English UI text, Lingui localization, keyboard operation, narrow-screen scrolling and RTL-safe layout.

## Non-goals

- Renaming the stable identifier, changing identifier validation or normalizing term slugs.
- A separate Taxonomy Types listing or taxonomy-order feature.
- Redesigning localization or exposing an additional singular-label field in this dialog.
- Fixing Kumo's disabled-text token mismatch as part of the EmDash feature. That is a separate dependency report.

## Interfaces and compatibility

Use the existing `GET` and `PUT /_emdash/api/taxonomies/{name}` contract. Add an internal admin update helper using `apiFetch`. The public API, permissions, configuration and database schema stay as they are. Existing identifiers and singular labels are preserved.

Every new visible string, error fallback and accessible label is wrapped in Lingui. English is the source language. The prototype's built English catalog contains all eleven new messages and ten reused messages. Czech preview translations are supplied separately; after the feature merges, the existing catalog extraction workflow can create the keys and a translation-only PR can fill their Czech `msgstr` values.

## Errors and edge cases

- Keep entered values visible after a failed save and show the API error through existing dialog error handling.
- Disable saving for read-only access, a pending mutation, an empty label or an unchanged form.
- Show loading and retry states for definition fetch failures.
- Preserve unrelated definition fields when concurrent changes are received.
- Saving a fallback definition must not silently create or overwrite another locale's label.
- Changing hierarchy or detaching a collection must not delete existing terms, assignments or parent links.

## Verification

Cover saved values on reopen, label persistence and sidebar refresh, preservation of the singular form, `false` hierarchy, empty collections, locale fallback, read-only roles, failure states and Arabic RTL. Manually verify term actions, keyboard use and a scrollable dialog at a narrow viewport.

The current preview passed root formatting, build, typecheck and both lint modes; nine dialog browser tests; Astro check; deployment dry-run; a successful DEV build; and manual disabled-state verification. Earlier preview testing also covered 49 admin tests, 33 core taxonomy integration tests, six site localization tests, eight performance tests and a real label save/reload/restore on DEV. Those earlier full-suite results are distinct from the nine tests rerun for the current preview.

The prototype and evidence are available in the [review preview release](https://github.com/onvarga/emdash/releases/tag/taxonomy-edit-prototype-1.2.0-20261010). Its ZIP separates the feature patch, local Kumo workaround, already-merged term-description fix, source, English catalog verification and Czech preview translations. The prototype source targets official EmDash 1.2.0; implementation will be rebased onto current main after design acceptance.

![Existing taxonomy actions expose deletion but no definition editing.](https://github.com/onvarga/emdash/releases/download/taxonomy-edit-prototype-1.2.0-20261010/taxonomy-actions.png)

![DEV prototype shows one Label, disabled Identifier, hierarchy and associated Collections.](https://github.com/onvarga/emdash/releases/download/taxonomy-edit-prototype-1.2.0-20261010/after-disabled-style.jpeg)

Related work: the broader Taxonomy Types proposal [#213](https://github.com/emdash-cms/emdash/pull/213), single-resource API discussion [#1346](https://github.com/emdash-cms/emdash/discussions/1346), and the separate deletion discussion [#3219](https://github.com/emdash-cms/emdash/discussions/3219). This plan exposes the existing definition fields on the current screen.
