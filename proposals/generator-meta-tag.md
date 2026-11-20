---
title: Identify EmDash sites with a generator meta tag
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-11-20
---

# Identify EmDash sites with a generator meta tag

## Problem and user case

Nothing in an EmDash site's pages names EmDash. Technology detectors such as Wappalyzer recognize Astro from its asset paths and report a production EmDash site as an Astro site. As a result:

- People evaluating EmDash can't confirm that a site they've found runs it.
- Usage studies can't count EmDash sites. The Web Almanac's CMS figures come from HTTP Archive's crawl, which detects technologies with [HTTP Archive's fork of Wappalyzer](https://github.com/HTTPArchive/wappalyzer) ([methodology](https://almanac.httparchive.org/en/2025/methodology)). That fork has no EmDash entry.

`GET /_emdash/api/health` already returns `product: "emdash"` and the full version without authentication. Crawlers don't find it, because they read only the requested page's HTML and headers.

Other systems name themselves with the `generator` meta tag, which the [HTML standard](https://html.spec.whatwg.org/multipage/semantics.html#meta-generator) defines as identifying "one of the software packages used to generate the document". WordPress, Drupal, Ghost and Joomla emit one by default. They differ in how much version they show. WordPress shows the full version, Ghost shows the major and minor version, Drupal shows the major version only, and Joomla shows no version. Drupal [chose the major version in 2008](https://www.drupal.org/project/drupal/issues/275092) so that its adoption could be measured without page source naming the patch release.

## Proposed behavior

`EmDashHead` renders a generator tag with EmDash's name and major version:

```html
<meta name="generator" content="EmDash 1" />
```

- The version is the major version of the installed `emdash` package. Version `1.6.2` renders `EmDash 1`, and `2.0.0-beta.1` renders `EmDash 2`. When the version isn't a release number, as in EmDash's own unit tests where it is `dev`, the tag reads `EmDash`.
- The tag follows Drupal's convention. The major version is enough to count adoption per release line, and the page source doesn't repeat the full version that the health endpoint returns.
- The tag appears on every page whose layout renders `EmDashHead`. The blog, starter, marketing and portfolio templates do, in their Node and Cloudflare versions. The `blank` template writes its own `<head>` and gets no tag. Prerendered pages get the tag, and so do pages rendered before the runtime is initialized.
- `EmDashHead` renders the tag directly, outside the page metadata contributions, so a plugin can't replace or remove it. A plugin's own `generator` contribution renders as a second tag. The HTML standard doesn't limit a page to one generator tag.

A site turns the tag off in its EmDash config:

```js title="astro.config.mjs"
emdash({
	generator: false,
});
```

`generator: false` removes only the tag. The health endpoint keeps returning the product and version.

## Goals

- Name EmDash, without setup, on every page whose layout renders `EmDashHead`.
- Show the major version, so usage studies can count adoption per release line.
- Keep page renders at their current query count.
- Let a site remove the tag with one option.

## Non-goals

- HTTP response headers such as `X-Generator` or `X-Powered-By`.
- Showing the full version in pages, or an option to show it.
- Changing what `/_emdash/api/health` returns.
- Agent discovery documents such as `llms.txt`, Markdown versions of pages, and `Link` headers. They describe what a site offers and need their own proposal.
- Detector fingerprints, which live in other repositories. The [detector follow-up](#detector-follow-up) describes them.

## Interfaces and compatibility

- `EmDashConfig` gains an optional `generator?: boolean`, defaulting to `true`, with JSDoc that names the tag it controls. The option joins the options schema in `packages/core/src/config/options-schema.ts`, and the integration passes it to `EmDashHead` in the serialized config. `EmDashHead` renders the tag unless the option is `false`.
- The configuration reference (`docs/src/content/docs/reference/configuration.mdx`) documents the option.
- The change is additive. Upgraded sites gain one tag in their HTML, with no stored data and no migration. The changeset names the tag and shows `generator: false` for sites that don't want it.
- The change is bounded and cheap to reverse, so it is a feature plan, not an RFC. The option is a boolean opt-out like `toolbar: false`, and removing the tag later would break no site.
- Query counts don't change. The tag comes from the package version and the config, which are both fixed at build time.
- The plugin API doesn't change.

## Errors and edge cases

- A site whose layout doesn't render `EmDashHead` gets no tag. It can add the tag to its layout by hand.
- A site in staging keeps the tag next to its `noindex` robots tag.

## Verification

- Unit tests cover the function that turns a version into the tag content: `1.6.2` gives `EmDash 1`, `2.0.0-beta.1` gives `EmDash 2`, and `dev` gives `EmDash`.
- Render tests in `packages/core/tests/repro/emdash-head.render.test.ts` check that:
  - the tag renders by default;
  - no tag renders with `generator: false`;
  - both tags render when a plugin contributes its own `generator`.
- The query-count snapshots don't change.
- The rendered HTML of `demos/simple` contains the tag.

## Detector follow-up

After the release that ships the tag, fingerprint pull requests go to HTTP Archive's fork and to [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer), the community continuation of Wappalyzer's open-source fingerprints. Wappalyzer's own fingerprints are closed, so EmDash is suggested to Wappalyzer through its website. The fingerprint matches the generator tag and implies Astro. It also matches `/_emdash/api/media/file/` URLs, which finds some sites with custom layouts: those that serve media through EmDash's media route.
