---
title: Full-content RSS for the blog template
type: feature-plan
status: proposed
authors:
  - Jojo Mensah (@jojomensah89)
discussion: null
created: 2026-10-28
---

# Full-content RSS for the blog template

## Problem and user case

The blog template's `/rss.xml` endpoint emits a title, permalink, publication date, and excerpt for each of its 20 most recent published posts. Feed readers and content importers receive only the excerpt, so they cannot read or import the post body or its Portable Text images. This proposal addresses [issue #2758](https://github.com/emdash-cms/emdash/issues/2758).

## Proposed behavior

Keep the existing RSS item fields and excerpt. Add an RSS 2.0 `content:encoded` element when a published post has a body. Render the body with EmDash's `PortableText` component so its image blocks include their media URL, alternative text, and caption.

Resolve relative link and media URLs against the post URL. Wrap the rendered HTML in CDATA and split any `]]>` terminator so the feed remains valid XML. Remove unsupported Portable Text block placeholders from the body.

If a post has no body or its render fails, keep its RSS item and excerpt and omit `content:encoded`. A rendering failure for one post must not prevent other posts from appearing. Draft and preview content must not appear in the public feed.

## Goals

- Preserve the existing title, link, GUID, publication date, excerpt, order, and item limit.
- Include rendered Portable Text bodies in `content:encoded`, including image URLs, alternative text, and captions.
- Emit absolute links and media URLs and valid XML.
- Keep each post's excerpt and the rest of the feed available when rendering fails.

## Non-goals

- Adding an admin Cards view.
- Changing EmDash's Portable Text renderer or public API.
- Adding RSS settings, a new feed endpoint, or stored data.

## Interfaces and compatibility

The feed adds the `content:encoded` element and its standard RSS content namespace. Existing fields and the `/rss.xml` endpoint remain unchanged. Readers that do not use `content:encoded` continue to receive the existing excerpt. Feed responses will be larger when posts have bodies.

The change belongs in the canonical blog template and its synchronized template and demo copies. It does not change a published package, database schema, or content API.

## Errors and edge cases

- Posts without a body remain excerpt-only.
- If Astro container creation fails, every post remains in the feed with its excerpt.
- If one post fails to render, only that post's encoded body is omitted.
- Unsupported Portable Text blocks are omitted without exposing renderer comments or placeholder text.
- XML-invalid control characters are removed, and CDATA terminators are split safely.
- Only published posts are queried and serialized.

## Verification

- Test full text and image blocks, including image URLs, alternative text, captions, and relative URL resolution.
- Test excerpt preservation, unsupported block omission, XML-invalid characters, and CDATA terminators.
- Test that posts without content and posts with render failures remain in the feed, and that a failure does not remove other posts.
- Build and typecheck the Cloudflare template and synchronized demos.
- Exercise `/rss.xml` in the Cloudflare local runtime with a published post and confirm that its image and text appear in `content:encoded`.
- Verify that all synchronized route and helper copies match.

## Open questions

- Is Astro's experimental `experimental_AstroContainer` API acceptable for rendering Portable Text at request time on the public Cloudflare Worker route? The implementation must pass a Cloudflare runtime test before its pull request is ready for review.
