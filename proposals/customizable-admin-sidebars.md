---
title: Customizable admin sidebars
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-10-29
---

# Customizable admin sidebars

## Problem and user case

Every section in the content editor's settings sidebar has a drag handle in its corner, so editors can reorder the sections. The handles are always visible, one per section. On Outline, Revisions, and sandboxed plugin panels, the handle sits next to the section's own expand button.

The admin keeps the resulting order in the browser's local storage, separately for each user and collection. The order doesn't follow the editor to another browser or device. New entries show fewer sections, so they neither use nor save the order.

The admin navigation has no personal customization. A site can hide some built-in entries for everyone with the `admin.hiddenNavItems` config option, but an editor who never opens Widgets or Menus can't remove them from their own navigation.

## Proposed behavior

Each user arranges both sidebars on one page, **Settings → Personal → Sidebars** (`/settings/sidebars`). The [interactive mockup](https://emdash-customize-sidebars-mockup.gifted-market-6ca.workers.dev/) shows the page with made-up content and people.

- The page has two lists, **Navigation** and **Editor sidebar**. Each row has a drag handle and a checkbox. Unchecking a row hides it, and dragging it or moving it with the keyboard changes its position. Each list has a Reset button.
- Navigation entries move within their group: the unlabeled group with Dashboard and Calendar, Content, Manage, Admin, or Plugins. An entry inside a folder moves within that folder. A folder row moves as one entry and has no checkbox; hiding all of its entries hides the folder. Dashboard always stays first and visible.
- The editor sidebar order applies to every collection and to new entries. Sections that a collection doesn't use, such as Translations on a site without translations, are skipped. Publish can move but can't be hidden.
- Changes apply as soon as the user makes them, and the navigation updates live.
- The layout belongs to the signed-in user and is saved to their account, so it applies in every browser. Nobody else's sidebars change.
- Every role can open the page. A new **Personal** group at the end of the Settings page holds it, together with the existing Language setting, which stays a per-browser setting. Users below Admin reach Settings from the user menu, because the navigation shows its Settings entry only to admins.
- The editor sidebar loses its drag handles. A **Customize sidebar** link at the bottom of the editor sidebar opens the page at the Editor sidebar list. A pencil link in the navigation footer also opens the page; it's hidden while the navigation is collapsed to icons.
- The command palette ignores the personal layout.

Linear ([Personalized sidebar](https://linear.app/changelog/2024-12-18-personalized-sidebar)) and Atlassian's Confluence ([Customize sidebar](https://support.atlassian.com/confluence-cloud/docs/what-is-the-new-navigation-in-confluence/)) also give each person a dedicated view for hiding and reordering sidebar items.

## Goals

- Remove the always-visible drag handles from the editor sidebar.
- Let each user hide and reorder entries in the admin navigation and sections in the editor sidebar.
- Arrange both sidebars on one page that every role can open.
- Save the layout to the user's account so it applies in every browser.
- Support keyboard reordering, screen readers, right-to-left languages, and phone screens.

## Non-goals

- Layouts that an admin sets for other users, or defaults for the whole site. `admin.hiddenNavItems` stays the site-wide control.
- Moving entries between groups, renaming entries, or adding custom links, groups, or folders.
- A different editor sidebar order for each collection.
- Customizing the editor's main column, its fields, or the panels a block opens in the sidebar, such as image details.
- Changing the command palette.

## Interfaces and compatibility

- **Stored data.** The layout lives in a new `adminLayout` key in the existing `data` JSON column of the `users` table, next to `welcomeDismissed`. There's no database migration.

  ```ts
  interface AdminLayout {
  	version: 1;
  	nav: { order: string[]; hidden: string[] };
  	editor: { order: string[]; hidden: string[] };
  }
  ```

  A navigation ID is the entry's admin path without its query string, such as `/content/posts`, `/taxonomies/category`, or `/plugins/forms/submissions`, or `folder:<label>` for a folder. An editor sidebar ID is the section's existing ID: `publish`, `url-language`, `ownership`, `bylines`, `translations`, `taxonomies`, `seo`, `outline`, `revisions`, `plugin:<pluginId>:<panelId>`, or `sandbox-plugin:<pluginId>:<panelId>`.

- **API.** `GET /_emdash/api/auth/me` also returns `adminLayout`: the stored layout if it passes validation, otherwise `null`. The admin already loads this response, and the route reads the session's user, so returning the layout adds no request and no query. `POST /_emdash/api/auth/me` accepts a new action, `{ "action": "setAdminLayout", "adminLayout": AdminLayout | null }`, which replaces the stored layout, or removes it when `adminLayout` is `null`. The action's body schema gains `adminLayout` as a strict object: `version` is the literal `1`, and each list holds non-empty strings. Like the existing `dismissWelcome` action, the new action needs a signed-in user and the `X-EmDash-Request` header, and a save costs what a `dismissWelcome` request costs today. Both changes are additive.

- **Resolving a layout.** The admin builds each sidebar in three steps:
  1. Start from what the user can see today. Role checks, `admin.hiddenNavItems`, hidden collections, disabled plugins, and each collection's features still decide which entries and sections exist.
  2. Within each sibling set (a group's entries, a folder's entries, or the editor sections), put the IDs listed in `order` first, in that order. The rest follow in their default order. `/` always comes first.
  3. Drop the IDs listed in `hidden`, except `/` (Dashboard) and `publish`.

- **Writing a layout.** Only the Settings page writes. It reloads the current user when it opens and enables its controls once the reload finishes.
  - Checking or unchecking a row adds or removes that one ID in `hidden`. IDs the page can't match stay in `hidden`, so an entry hidden before its plugin was disabled stays hidden when the plugin comes back.
  - A list's `order` changes only when the user moves an entry in that list. The page then writes the order of every entry the list shows, which drops IDs it can't match.
  - The page sends one save at a time. While a save is in flight, it queues only the latest layout. When a save fails, the page drops the queued layout, restores the last layout the server accepted, and shows the server's error.

- **Settings page.** The Navigation list shows the entries the user can see. The Editor sidebar list shows the sections and plugin panels the user would see in at least one collection, including hidden collections.

- **Editor sidebar.** `SortableContentSettingsSections` drops its drag handles and its local-storage order, and new entries follow the saved order. Orders already saved in browsers (`emdash:content-settings-layout:v1:*`) don't carry over, so everyone starts from the default order. The old keys stay in browser storage unused.

- **Plugins.** No API change. Users can hide and reorder plugin pages and editor panels like built-in entries. A panel's declared `order` still sets its default position among the plugin panels, which come after SEO and before Outline.

## Errors and edge cases

- A missing or invalid stored layout counts as no layout. The admin drops duplicate IDs when it reads one.
- The auth middleware loads and parses `users.data` on every authenticated request, so the action keeps the layout small. It rejects an `adminLayout` whose JSON is larger than 16 KB in UTF-8, or a list with more than 200 IDs, with `VALIDATION_ERROR`.
- A tab holding an older layout overwrites changes saved from another tab. Because the Settings page reloads the layout when it opens, this takes two Settings pages open at once. A layout save and a `dismissWelcome` request at the same moment can also overwrite each other, because each rewrites the whole `data` value.
- In a list with a saved order, a new collection, taxonomy, plugin page, or plugin panel appears after the saved entries in its group, folder, or list.
- An entry that disappears, for example because its plugin is disabled, and comes back after the user has moved something in that list returns to its default position.
- Renaming a folder resets its position, because folder IDs use the label.
- When every entry in a group is hidden, the group's heading disappears from the navigation.
- Hiding a section hides its controls. A user who hides URL & language can't edit the slug until they show the section again.
- A user who hides Settings can still reach it from the user menu.
- Some navigation entries, such as Comments and Redirects, have no command palette entry, so once hidden they open only from links or their URL.

## Verification

- Unit tests for resolving a layout: saved order, new and unknown IDs, duplicates, folders, and entries that can't be hidden.
- Unit tests for writing a layout: toggling a row keeps unmatched IDs in `hidden`, a move writes the displayed order, and a checkbox change leaves `order` alone.
- Unit tests for reading a stored layout: missing, malformed, and wrong-version values.
- API tests on SQLite and PostgreSQL: a layout round-trips through `POST` and `GET`, `null` clears it, invalid and oversized layouts get `VALIDATION_ERROR`, and other keys in `data`, such as `welcomeDismissed`, survive a save.
- Browser tests: hiding and reordering on the Settings page update the navigation at once, the editor sidebar follows the saved order, keyboard reordering announces positions, Reset restores the default, and a failed save restores the last accepted layout.
- A manual pass at phone width, in Arabic, and in dark mode.

## Open questions

- Should admins be able to set a default layout for their team? Confluence users have an [open request](https://jira.atlassian.com/browse/CONFCLOUD-82104) for sidebars that admins set for everyone.
- Should hidden navigation entries move behind a "More" entry, as in Linear, instead of disappearing?
