# @emdash-cms/blocks

## 1.4.1

### Patch Changes

- [#4495](https://github.com/emdash-cms/emdash/pull/4495) [`76f0f53`](https://github.com/emdash-cms/emdash/commit/76f0f53221c380cc77b73da5e455408dca720902) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates the admin's confirmation, form and notice dialogs to Kumo's `LayerDialog` design. Each dialog keeps its title in a fixed header, scrolls its content in a card, and puts Cancel and the main action in a tray along the bottom. On phones, dialogs open as bottom sheets, and most can be swiped down to dismiss. Block Kit button confirmations on plugin admin pages use the same design.
  
  Inside dialogs, groups of fields share one section heading style, selects fill the width of their column, and paired fields stack on phones. Explanations that used to sit under fields, such as "Slugs cannot be changed after the field is created.", are behind an info button beside the label, which opens on hover, keyboard focus or a tap. Errors, warnings about what an action will do, and format rules the dialog does not check stay visible. Screen readers read an info button's note as the button's description, without opening it.
  
  Dialogs with Cancel and an action no longer show a separate close (×) button; Cancel and Escape behave as before. In the byline and media folder dialogs, Delete moves from the bottom bar to a row at the end of the dialog that says what deleting does, and the byline avatar shows as a small circle with its actions beside it. Creating a relationship from the field dialog opens it in a second dialog on top, whose Back button returns to the field, and the relation form no longer says it cannot generate a slug before both side names are filled in. A confirmation's message sits under its title and is the dialog's description for screen readers. Form dialogs, such as the field, menu item and schedule dialogs, now also say what they are for under the title, and screen readers read that sentence instead of the whole form. The media picker, media details, media upload, bulk tagging, content picker and section picker dialogs keep their previous layout.
  
  Browser tests that clicked a dialog's "Close" button should click "Cancel" or press Escape instead. A dialog now takes focus itself when it opens, unless one of its fields takes focus, so press Tab to reach its first control. The plugin permissions and uninstall dialogs are now named by their titles, such as "Plugin Permissions" and "Uninstall Gallery?", instead of "Capability consent" and "Uninstall confirmation". A label locator such as `getByLabel("Slug")` can also match the new "More information about Slug" button, so pass `{ exact: true }` or locate the field by its role. An info button's note is also in the page as the button's hidden description, so locate the open note with `getByRole("tooltip")` rather than by its text.

- [#4308](https://github.com/emdash-cms/emdash/pull/4308) [`4df65eb`](https://github.com/emdash-cms/emdash/commit/4df65eba3e4dd2f990c92f65a4748117182949d5) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates `@cloudflare/kumo` to 2.15.0. These packages now require exactly `@cloudflare/kumo@2.15.0`, so sites and plugins that install Kumo themselves should upgrade to that version to match the admin's prebuilt styles. Update `emdash` and the Forms, Field Kit, AI Moderation and AI Search plugins together: their earlier releases require Kumo 2.6.0, and these plugin releases need an `emdash` release with this change. Updating only one side leaves Kumo 2.15 next to an admin built for 2.6.
  
  In the admin, Select menus now open below their field instead of over it, and text sized `text-base` or `text-lg` has a taller line (1.5), so labels and headings take slightly more height. Kumo's `DropdownMenu` now spaces item icons itself, so plugin admin pages should remove any margin classes such as `me-2` from the elements they pass as an item's `icon`.

## 1.4.0

### Patch Changes

- [#4183](https://github.com/emdash-cms/emdash/pull/4183) [`190022c`](https://github.com/emdash-cms/emdash/commit/190022cbd71a20d06c856cf5673acb0b2d2d9f1f) Thanks [@masonjames](https://github.com/masonjames)! - Fixes nested HTML forms in the content editor by rendering Block Kit form blocks as groups of fields instead of native `<form>` elements. This also applies to form blocks on plugin pages.

## 1.3.1

### Patch Changes

- [#4219](https://github.com/emdash-cms/emdash/pull/4219) [`9e74ea3`](https://github.com/emdash-cms/emdash/commit/9e74ea36b88509ba3e6b61f718aabe4dda26784a) Thanks [@emdash-autofix](https://github.com/apps/emdash-autofix)! - Fixes Block Kit button confirmation dialogs displaying content flush against the edges, matching the padding and small size of admin confirmation dialogs.

## 1.3.0

No changes in this release.

## 1.2.0

No changes in this release.

## 1.1.0

### Patch Changes

- [#3675](https://github.com/emdash-cms/emdash/pull/3675) [`85ab50c`](https://github.com/emdash-cms/emdash/commit/85ab50c60e325b564b427d2d7ffde7e903c2dbf7) Thanks [@masonjames](https://github.com/masonjames)! - Fixes a Block Kit form in a plugin's content editor panel reloading the editor when submitted, instead of sending its values to the plugin.

- [#3673](https://github.com/emdash-cms/emdash/pull/3673) [`3a00448`](https://github.com/emdash-cms/emdash/commit/3a00448c05604eab26c4ad2b851d33b2de8bc605) Thanks [@masonjames](https://github.com/masonjames)! - Fixes Block Kit `select` elements showing the selected option's value instead of its label, so a plugin page, form or editor panel that offers `{ value: "eip155:84532", label: "Base Sepolia" }` now displays "Base Sepolia". The value sent to the plugin is unchanged.

## 1.0.1

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. Before upgrading from 0.42, read the [upgrade guide](https://docs.emdashcms.com/upgrade-to-v1/), which lists each change and how to migrate.
  
  From this release, breaking changes ship only in a new major version.

## 1.0.1-rc.1

No changes in this release.

## 1.0.1-rc.0

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. The other entries for this version describe each one and how to migrate; check them before upgrading from 0.42.
  
  From this release, breaking changes ship only in a new major version.
  
  The first 1.x version is 1.0.1. npm also lists a deprecated `emdash@1.0.0`, published by mistake from 0.7-era code; do not install it.

## 0.42.0

### Minor Changes

- [#3483](https://github.com/emdash-cms/emdash/pull/3483) [`2e943ff`](https://github.com/emdash-cms/emdash/commit/2e943ff35fcffc5a4e35dd658ef73cf098030e3b) Thanks [@swissky](https://github.com/swissky)! - Adds row actions to Block Kit tables and a new `menu` element. Set a table column's `format` to `"element"` to place a `button`, `link`, or `menu` in each row under that column's key. A `menu` is a button that opens a list of choices; choosing one sends a `block_action` with the menu's `action_id` and the choice's `value`. Menus also work in `actions` blocks, section accessories, and empty-state actions, but not as form fields. Build one with `elements.menu(actionId, label, items, { style })`; the `MenuElement` type is exported. Existing tables and elements are unchanged.

### Patch Changes

- [#3480](https://github.com/emdash-cms/emdash/pull/3480) [`f2f9119`](https://github.com/emdash-cms/emdash/commit/f2f9119738ba360d02e3fd00e1cf7d1d49b52fda) Thanks [@swissky](https://github.com/swissky)! - Fixes Block Kit table column headings being centered instead of aligned with their column's content. Headings in plugin admin pages, dashboard widgets, and content editor panels now line up at the start of each column, on the right in right-to-left admin languages.

## 0.41.0

No changes in this release.

## 0.40.1

No changes in this release.

## 0.40.0

No changes in this release.

## 0.39.1

No changes in this release.

## 0.39.0

### Minor Changes

- [#3188](https://github.com/emdash-cms/emdash/pull/3188) [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds saved-entry panels and actions for sandboxed plugins. Declare collection-filtered `admin.editorPanels` and `admin.editorActions` entries that point to private plugin routes.
  
  Panels load Block Kit only when an editor opens them. Actions support confirmation and can return a toast, request an entry refresh, or navigate through a structured link target. EmDash reloads and ownership-authorizes the saved entry before invocation, then exposes only its canonical identity, locale, and version through `routeCtx.ui`; unsaved editor values never cross the sandbox boundary.
  
  `createPluginRuntimeTestHost()` includes panel and action helpers that exercise the production authorization, response-validation, and Worker Loader path.

- [#3251](https://github.com/emdash-cms/emdash/pull/3251) [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds explicit, consented access to selected unsaved content for sandboxed editor panels and actions.
  
  Plugins can request `admin.editor-draft:read` to receive extension-selected field values after an editor invokes them, and `admin.editor-draft:patch` to propose atomic whole-field `set` or `clear` operations. Patch access does not imply read access. Each extension must declare explicit collection scope and narrow its access to field slugs, translatable fields, or both.
  
  EmDash authenticates and authorizes the saved entry, reloads its schema and revision, validates snapshot and patch limits, and rejects stale or invalid responses. The admin shows a host-rendered before-and-after preview, applies accepted changes to the visible form, marks it dirty, and leaves saving to the editor. Panel load and ordinary typing do not expose draft data or invoke the plugin.
  
  `createPluginRuntimeTestHost()` now provides draft capture and host-validated patch application helpers for production-boundary plugin tests.

- [#3174](https://github.com/emdash-cms/emdash/pull/3174) [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds structured Block Kit navigation and host-attested administrator locale context for sandboxed plugin pages and dashboard widgets.
  
  Plugins can return `link` elements that target saved content, another page declared by the same plugin, generated plugin settings, or an external HTTP, HTTPS, or `mailto:` URL. EmDash constructs internal admin URLs and opens external links with `noopener noreferrer`. Links never dispatch block actions and cannot appear as form fields.
  
  Block Kit route handlers receive `routeCtx.ui` with the validated surface, administrator locale, and text direction. The host validates every sandboxed page and widget response before rendering it, rejects undeclared plugin-page targets and active URL protocols, and permits external images only over HTTPS to hosts declared in `allowedHosts` under `network:request` consent or under `network:request:unrestricted` consent. Responses are limited to 256 KiB, 20 levels, 2,000 nodes, 1,000 items per array, and 64 KiB per string.
  
  `createPluginRuntimeTestHost()` adds `admin.loadPage()`, `loadWidget()`, `act()`, and `submit()` helpers that exercise the private production route, Worker Loader isolate, host UI context, and response validation.
  
  This is a breaking security tightening for sandboxed plugins that return an external Block Kit image without matching network authority. EmDash rejects the complete page or widget response instead of allowing the administrator's browser to contact an unapproved host.
  
  #### What should I do?
  
  If a plugin returns external Block Kit images, add `network:request` and every image hostname to `allowedHosts`, or add `network:request:unrestricted` when the plugin genuinely requires any hostname. Publish a plugin update so administrators can review and approve the expanded authority. Root-relative images need no manifest change.

### Patch Changes

- [#3252](https://github.com/emdash-cms/emdash/pull/3252) [`fc32ebf`](https://github.com/emdash-cms/emdash/commit/fc32ebff4b43495e3908cd48eb2a7acc00a6b51d) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes native plugin pages declared at `/` disappearing from the admin sidebar and command palette.

## 0.38.0

No changes in this release.

## 0.37.0

## 0.36.0

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.1

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.1

## 0.25.0

## 0.24.1

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.1

## 0.16.0

## 0.15.0

### Patch Changes

- [#1177](https://github.com/emdash-cms/emdash/pull/1177) [`b9cc08e`](https://github.com/emdash-cms/emdash/commit/b9cc08e7556ccdbcbbcea6d3c06cae6abef18766) Thanks [@ascorbic](https://github.com/ascorbic)! - Bumps `@cloudflare/kumo` from 1.16 to 2.3. Two internal call sites picked up breaking API changes from Kumo 2.0: `Collapsible` is now a compound component (`Collapsible.Root` / `.DefaultTrigger` / `.DefaultPanel` instead of `<Collapsible label=...>`), used by the accordion block; and `ChartPalette.color()` was renamed to `ChartPalette.categorical()` in the chart block. No public API changes -- consumers see identical behaviour. Tests in `@emdash-cms/admin` that asserted on `Button`'s native `title` attribute now read `aria-label` instead, because Kumo 2 wraps `<Button title>` in a Tooltip popup rather than setting the DOM attribute.

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

### Minor Changes

- [#717](https://github.com/emdash-cms/emdash/pull/717) [`5eb4318`](https://github.com/emdash-cms/emdash/commit/5eb431876cbfb69a961735fbb6ab09c9de937f28) Thanks [@lsngmin](https://github.com/lsngmin)! - Add Tab block to Block Kit for tabbed panel layouts

## 0.9.0

### Minor Changes

- [#790](https://github.com/emdash-cms/emdash/pull/790) [`7b8d496`](https://github.com/emdash-cms/emdash/commit/7b8d4964c619821937d1a738cbd6f81e98095a91) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds an `accordion` Block Kit block: a collapsible container that wraps nested blocks under a labeled trigger. Open/closed state is local to the rendered component (with optional `default_open`), so plugin admin pages can hide advanced settings, FAQs, or auxiliary panels without paginating or round-tripping through `block_action`.

- [#731](https://github.com/emdash-cms/emdash/pull/731) [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea) Thanks [@drudge](https://github.com/drudge)! - Adds a `media_picker` Block Kit element: a thumbnail preview with a modal library picker and mime-type filter. Usable in plugin block forms and in Block Kit field widgets. The stored value is the selected asset's URL string, so it is value-compatible with a plain `text_input` — existing content continues to work after swapping. The `mime_type_filter` is restricted to image MIME types (`image/` or `image/<subtype>`); wildcards and non-image types are rejected.

- [#814](https://github.com/emdash-cms/emdash/pull/814) [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19) Thanks [@arashackdev](https://github.com/arashackdev)! - rtl srtyle improvements and LTR/RTL compatible arrow/caret icons

## 0.8.0

### Minor Changes

- [#792](https://github.com/emdash-cms/emdash/pull/792) [`6e0e921`](https://github.com/emdash-cms/emdash/commit/6e0e9215e00f6f2e84ade30447e4c30b1812dbf5) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds an `empty` Block Kit block: a styled empty-state placeholder with title, optional description, copyable shell command, size variant (`sm`/`base`/`lg`), and an optional list of action elements (CTAs). Plugin admin pages can now render proper empty states for lists, tables, and onboarding flows without rolling their own layout.

- [#679](https://github.com/emdash-cms/emdash/pull/679) [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d) Thanks [@drudge](https://github.com/drudge)! - Adds a `repeater` Block Kit element: array-of-objects with scalar sub-fields, drag-to-reorder, and collapsible item cards. Plugin block forms can now capture repeating data (FAQ rows, carousel slides, card grids) inline in the portable-text editor.

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- [#246](https://github.com/emdash-cms/emdash/pull/246) [`e1349e3`](https://github.com/emdash-cms/emdash/commit/e1349e342f90227c50f253cc2c1fbda0bc288a39) Thanks [@estepanov](https://github.com/estepanov)! - Adds overflow-hidden and text-ellipsis to field value elements, with a title attribute for full-text tooltip on hover

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
