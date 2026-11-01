# @emdash-cms/plugin-ai-search

## 0.1.1

### Patch Changes

- [#4308](https://github.com/emdash-cms/emdash/pull/4308) [`4df65eb`](https://github.com/emdash-cms/emdash/commit/4df65eba3e4dd2f990c92f65a4748117182949d5) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Updates `@cloudflare/kumo` to 2.15.0. These packages now require exactly `@cloudflare/kumo@2.15.0`, so sites and plugins that install Kumo themselves should upgrade to that version to match the admin's prebuilt styles. Update `emdash` and the Forms, Field Kit, AI Moderation and AI Search plugins together: their earlier releases require Kumo 2.6.0, and these plugin releases need an `emdash` release with this change. Updating only one side leaves Kumo 2.15 next to an admin built for 2.6.
  
  In the admin, Select menus now open below their field instead of over it, and text sized `text-base` or `text-lg` has a taller line (1.5), so labels and headings take slightly more height. Kumo's `DropdownMenu` now spaces item icons itself, so plugin admin pages should remove any margin classes such as `me-2` from the elements they pass as an item's `icon`.

## 0.1.0

### Minor Changes

- [#4071](https://github.com/emdash-cms/emdash/pull/4071) [`772838d`](https://github.com/emdash-cms/emdash/commit/772838d20a748a42d9e1c03ad94a992006745bef) Thanks [@ttmx](https://github.com/ttmx)! - Adds `@emdash-cms/plugin-ai-search`, a site search plugin powered by Cloudflare AI Search. It indexes published content and author profiles, keeps the index current as content changes, and adds an `AiSearch` component with a search button and modal. Choose what to index in the plugin's setup wizard in the admin. Requires EmDash 1.0.1 or later.
  
  The plugin connects through an AI Search binding on Cloudflare Workers, or through a Cloudflare API token on any platform, including Node.js.
  
  This plugin replaces `aiSearch` from `@emdash-cms/cloudflare/plugins`. The [AI Search plugin guide](https://docs.emdashcms.com/plugins/ai-search/) covers setup, API token rate limits and switching.
