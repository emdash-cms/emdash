---
title: Add a meta generator tag to EmDashHead
type: feature-plan
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
discussion: null
created: 2026-11-20
---

# Add a meta generator tag to `EmDashHead`

## Problem and user case

Every page EmDash renders should say that it was made with EmDash, to anyone who reads its HTML: a person viewing source, a crawler, an archive, or an agent with a saved copy. Today nothing in the page does. An EmDash page reads as an Astro page, and nobody can tell from the page alone that EmDash's editor, documentation and APIs are behind it.

The established CMSs name themselves in every page with the `generator` meta tag, which the [HTML standard](https://html.spec.whatwg.org/multipage/semantics.html#meta-generator) defines as identifying "one of the software packages used to generate the document". WordPress, Drupal, Ghost and Joomla emit it by default, and crawl-based counts of how much of the web each one runs read it. Drupal [turned its tag on in 2008](https://www.drupal.org/project/drupal/issues/275092) to make Drupal more visible and its spread measurable. Ghost [declined to remove its tag](https://forum.ghost.org/t/remove-generator-meta-tag/14955) because the project's metrics depend on it.

They differ in how much version they show. WordPress shows the full version, Ghost shows the major and minor version, Drupal shows the major version only, and Joomla shows no version.

`GET /_emdash/api/health` already returns `product: "emdash"` and the full version without authentication. It's a separate request to a path the reader has to know, and the page itself carries nothing.

## Proposed behavior

`EmDashHead` renders a generator tag with EmDash's name and major version:

```html
<meta name="generator" content="EmDash 1" />
```

- The version is the major version of the installed `emdash` package. Version `1.6.2` renders `EmDash 1`, and `2.0.0-beta.1` renders `EmDash 2`. When the version isn't a release number, as in EmDash's own unit tests where it is `dev`, the tag reads `EmDash`.
- The tag shows only the major version, as Drupal's does. Site owners and security scanners often treat a visible version as a security issue, and sites that get those reports tend to turn the tag off entirely. A major version alone gives them less to object to, so more sites keep the tag on. Adding the minor version, as Ghost does, would tell releases within a major line apart but invites the same objections.
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

- Name EmDash, without setup, in the HTML of every page whose layout renders `EmDashHead`.
- Show the major version, so counts of EmDash sites can be split by release line.
- Keep page renders at their current query count.
- Let a site remove the tag with one option.

## Non-goals

- HTTP response headers such as `X-Generator` or `X-Powered-By`. EmDash's middleware could add one to every server-rendered response, but prerendered pages are served as static files without it, and a saved copy of a page never carries headers. A site whose layout skips `EmDashHead` can write the tag in its own `<head>`.
- Showing the full version in pages, or an option to show it.
- Changing what `/_emdash/api/health` returns.
- Agent discovery documents such as `llms.txt`, Markdown versions of pages, and `Link` headers. They describe what a site offers and need their own proposal.
- Technology detector fingerprints, which live in other repositories. The [follow-up](#follow-up) describes them.

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

## Follow-up

Once a release ships the tag, EmDash gets added to the technology detectors that read it: Wappalyzer, [HTTP Archive's fork of Wappalyzer](https://github.com/HTTPArchive/wappalyzer), which the Web Almanac uses ([methodology](https://almanac.httparchive.org/en/2025/methodology)), and [enthec/webappanalyzer](https://github.com/enthec/webappanalyzer). Their fingerprints also match EmDash media URLs, which finds sites with custom layouts that serve media through EmDash's media route. Optimized images reach the HTML through Astro's image endpoint, so the fingerprints match the encoded form, `/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2F…`, as well as the plain `/_emdash/api/media/file/` path.
