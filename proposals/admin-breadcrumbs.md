---
title: Breadcrumbs on nested admin pages
type: feature-plan
status: implemented
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-11-15
---

# Breadcrumbs on nested admin pages

## Problem and user case

Many admin pages sit under another page: each settings page under Settings, one menu under Menus, one content type under Content Types, a media folder under Media. These pages have no consistent way to show where they sit or to go up one level. Each builds its own way back, and they differ:

- Settings sub-pages, plugin settings, a content type, Relations and a section show an icon-only back button beside the title.
- The menu editor shows an arrow and "Back" text button above its title.
- A registry plugin's page shows a "Back to plugins" text link.
- The media library shows a "Back" button above its title and a Kumo `Breadcrumbs` trail below it when a folder is open.

An editor moving from Settings into a settings page, or from Menus into one menu, sees a different "up" control on almost every screen.

## Proposed behavior

A page that sits under another page shows a breadcrumb trail at the start of the sticky header, in the space that's empty today. The trail is Kumo's `Breadcrumbs` component at its `sm` size, which matches the admin's 14px text. The [interactive prototype](https://emdash-admin-breadcrumbs-prototype.gifted-market-6ca.workers.dev) is the real admin, built as a read-only static site with recorded sample content.

```text
Settings › General
Menus › Main navigation
Content Types › Products
Registry › SEO Toolkit
Media › Product photos
```

The trail follows these rules:

- It starts at the parent page, such as **Settings**, **Menus** or **Content Types**. There's no home crumb, because the navigation's Dashboard entry and logo already go home.
- The last crumb is the current page. It isn't a link and has `aria-current="page"`. Every earlier crumb is a router link.
- Top-level pages, such as the Posts list, Media, Menus and Settings, show no trail. The navigation already highlights them, and a single crumb would repeat the page's heading.
- The content editor keeps its own bar, which already has a back arrow named "Back to {collection} list" and, on wide screens, "Posts / {title}". Its header shows no trail.
- Parent crumbs open the same destinations that today's back controls open. They never link to a page the user couldn't already reach from the child page.
- A crumb's label is the page's navigation label, its row title on the Settings page, the item's own name, or the page's title, such as "Relations". A few labels differ slightly from the page's heading, such as **General** above the heading "General Settings".

The trail for each nested page:

| Page                                                    | Trail                                                 |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Each settings page                                      | Settings › {row title on the Settings page}           |
| One menu (`/menus/$name`)                               | Menus › {menu label}                                  |
| One section (`/sections/$slug`)                         | Sections › {section title}                            |
| New content type, Relations, one content type           | Content Types › New content type, Relations or {type} |
| Plugin settings (`/plugins-manager/$pluginId/settings`) | Plugins › {plugin name}                               |
| Registry plugin (`/plugins/registry/$publisher/$slug`)  | Registry › {plugin name}                              |
| A media folder (`/media?folder=…`)                      | Media › {folder name}                                 |

Some current crumbs come from data the page loads: a menu, section, content type, plugin or folder. Their routes are marked as dynamic. The page shows Kumo's loading skeleton in the current crumb while it loads, then the item's name. A page whose data is already cached names the crumb before the browser paints, so no skeleton appears. When no page claims the crumb, for example because the route shows "Access denied" or a not-found page instead, the crumb shows the route's label. Parent crumbs never wait on data, and the trail doesn't change length while a page loads.

The trail replaces the per-page back controls listed above: the settings back button, the content type, Relations, section and plugin settings back buttons, the menu editor's Back button, the registry plugin's "Back to plugins" link, and the media library's Back button and in-page folder trail. The empty folder's "Back to Main library" action stays, because it's a recovery action inside an empty state. Page headings stay where they are.

With a folder open, the **Media** crumb is a plain link to the library. The library already goes back to its first page whenever the folder in the URL changes. The removed Back button also kept the scroll position and moved focus to the library heading in its click handler, so the browser's Back button skipped both. The library now does both whenever the folder changes, whatever caused it.

### Small screens, right-to-left and assistive technology

- No trail has more than two crumbs, so phones show the whole trail after the navigation toggle.
- Below the `sm` breakpoint the header's View Site button shows only its icon and keeps "View Site" as its accessible name. At 320px with the Staging badge showing, the trail gets about 100px.
- Parent crumbs keep their full width and only the current crumb truncates, which is Kumo's behavior. Parent labels are short page names.
- In right-to-left locales the trail reads from the right and the separators mirror. Each crumb isolates its text with `dir="auto"`, so a Latin menu name in an Arabic admin keeps its own order.
- The trail is a `nav` landmark with a translated name ("Breadcrumb"), and its separators are hidden from assistive technology.

## Goals

- Show one breadcrumb trail, in one place, on every nested page in the table above.
- Replace those pages' back buttons and links with the trail's parent crumb, so nested pages have one way up.
- Name dynamic levels (menus, sections, content types, plugins, folders) without the trail changing length while the page loads.
- Support phone widths, right-to-left languages, screen readers and keyboard users.

## Non-goals

- A trail on top-level pages.
- Changing the content editor's bar or its back arrow.
- Changing the browser tab title. It keeps its current text.
- Breadcrumbs on the standalone pages outside the shell: setup, login, sign-up, invitation and device authorization.
- The retired plugin and theme marketplace pages.
- An API for plugins to add levels below their admin pages. That would extend the plugin surface and needs its own proposal.
- Remembering a list's search, sort or page when an editor goes back to it. That state lives in the list component today, not in the URL.
- Sibling switchers on crumbs, such as a menu on **Menus** that switches to another menu.
- Moving page actions into the header.

## Interfaces and compatibility

- **Public interfaces.** None. There's no new configuration, API route, stored data or exported component.
- **Route metadata.** Nested admin routes gain an optional `breadcrumb` entry in `staticData`, next to the existing `pageTitle` and `fullBleed`:

  ```ts
  staticData: {
  	pageTitle: msg`Edit menu`,
  	breadcrumb: { parent: "/menus", dynamic: true },
  }
  ```

  `parent` is the path of the parent route, filled with the child's own params. Only the routes in the table above set `parent`, and a route without it shows no trail. `label` names the route's crumb when it appears as a parent or as a static current crumb, and defaults to `pageTitle`. A route sets it when the two differ, such as `` msg`General` `` for `/settings/general` and `` msg`Registry` `` for `/plugins/registry` (page title "Plugin Registry"), or when the route has no `pageTitle`, such as `/settings/sidebars`. `dynamic` marks a route whose page names the current crumb. The shell builds the trail by following `parent`.

- **Dynamic names.** A page names its current crumb with an internal hook, `useBreadcrumbLabel(label)`. It sets the label in a layout effect. Like the existing `useAdminPageTitle` override in `AdminDocumentTitle.tsx`, the context that pages read carries only the setter, memoized per page, and the label lives in state that only the trail reads, so setting it never re-renders the page. `undefined` shows the skeleton. Until a mounted page calls the hook, a dynamic crumb shows the route's label, so a page that never mounts can't leave the skeleton up. A page whose item fails to load or doesn't exist passes the route's label.

  The media library is the one page that adds a level below its route. With a folder open, it calls `useBreadcrumbLabel(folderName, { nested: true })`: the folder name becomes the current crumb, and the route's own **Media** crumb becomes a link to the route without its search parameters.

- **Links.** Every parent crumb is a plain path, which `Breadcrumbs.Link` sends through the admin's existing `LinkProvider` to the router. The router marks a link as current when the current page is under its path, so the bridge matches breadcrumb links exactly. Only the last crumb is the current page.
- **Kumo.** In Kumo 2.15.0, which the admin uses, `Breadcrumbs` hard-codes the English landmark name "breadcrumb" and doesn't mirror its separator in right-to-left layouts. Kumo 2.19.0 adds a `breadcrumbs` section to `KumoLocaleProvider`, an `aria-label` override, and a mirrored separator ([cloudflare/kumo#945](https://github.com/cloudflare/kumo/pull/945), which fixes [cloudflare/kumo#946](https://github.com/cloudflare/kumo/issues/946)). The implementation upgrades Kumo to 2.19.0 or later, translates the new section in `KumoTranslationsProvider.tsx`, and uses Kumo's `Breadcrumbs` parts as they are.
- **Removed controls.** The controls named "Back to settings", "Back to menus", "Back to sections", "Back to plugins" and "Back to Content Types" go away, as do the media library's "Back" button and its "Folders navigation" trail. Page-level component tests mount pages without the shell, so their assertions on these controls move to shell-level tests, or are deleted where they only check that a back control exists. Browser tests switch to the parent crumb.
- **Translations.** The new strings are the three Kumo breadcrumb labels ("Breadcrumb", "Copy" and "Click to copy"). The removed "Back to …" labels and "Folders navigation" become unused in the catalogs. The plain "Back" string stays, because other dialogs use it.
- **Visual baselines.** The nested pages and the header at phone width change, so the implementation pull request needs new visual regression baselines for those screens.

## Errors and edge cases

- A dynamic crumb shows the route's label, such as "Edit menu", when the page can't load its item or doesn't mount at all.
- A child page requires the same role as its parent or a higher one, and every parent is a page that today's back control already opens. Settings sub-pages link to Settings, which every role can open.
- Media folders don't nest, so the folder trail has two crumbs. A route that adds a third level would collapse on phones to "… › {parent} › {current}", Kumo's behavior, and Kumo's "…" isn't a link.

## Verification

- Admin browser tests render the shell for each kind of trail: a settings page, a static child such as Relations, a dynamic crumb that shows the skeleton and then the name, a dynamic page whose item fails to load, a dynamic route whose page never mounts, such as plugin settings for a non-admin, and the media folder trail. They assert the landmark's translated name, each link's destination, and `aria-current` on the last crumb only. A top-level page and the content editor render no trail.
- A test walks the real route tree and fails if a route names a parent that isn't a route, if a route with a parent has no label, or if the routes with a parent aren't exactly the nested pages in the table.
- The media library's focus and scroll browser tests pass when they click the **Media** crumb, and when they use the browser's Back button to leave a folder.
- At 320px with the Staging badge showing, a long menu name truncates without pushing the header's actions off screen. In Arabic the separators mirror and the trail starts from the right.
- The accessibility spec passes on every shell screen.
- Manual checks in light and dark mode, in Arabic, and at phone width, with screenshots of a settings page, one menu, one content type and a media folder.
