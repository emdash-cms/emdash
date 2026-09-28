# Content, schema, translations, and publication

Plugin content APIs are capability-gated and shared by native, Cloudflare Worker Loader, and Node/workerd execution.

## Discovery and reads

`schema:read` exposes `ctx.schema.listCollections()` and `getCollection()` for batched public collection and field definitions.

`content:read` exposes `ctx.content.get()`, `list()`, `getTranslations()`, and `getPublicUrl()`. Content results include identity, slug, status, locale, data, timestamps, author ID, translation group, live and draft revision pointers, and row version. Public URL resolution returns only published routable URLs, never previews.

`content:revisions:read` adds `listRevisions()` and `getRevision()`. Revision snapshots can retain field values removed later but omit revision-author identity.

## Writes and translations

`content:write` adds create, update, and delete. Create a translation with:

```typescript
await ctx.content!.create("posts", data, { locale: "fr", translationOf: sourceId });
```

The source must be an active entry in the same collection. The new row joins its translation group and inherits non-translatable fields, byline credits, and taxonomy assignments. Validation and save hooks run, with re-entrancy fencing for the creating plugin. A group permits one active row per locale.

Stable failures include `CONFLICT`, `NOT_FOUND`, `VALIDATION_ERROR`, and `SAVE_REJECTED`.

## Publication policy

`hooks.content-policy:register` enables `content:beforePublish`, `content:beforeSchedule`, and `content:beforeUnpublish` without granting content reads, writes, or publication actions. Return `{ cancel: true, reason }` to reject an action.

Events identify API, MCP, visual-editor, plugin, scheduler, and system origins. Authenticated human actions include actor identity and source. Scheduled publication runs the publish policy again; rejection unschedules the entry and records the bounded reason for administrators.

## Publication and restore actions

`content:publish` adds `getVersioned()`, `publish()`, `unpublish()`, `schedule()`, and `unschedule()`. Read first and pass the opaque `_rev` to every mutation. A successful action returns the next revision and runs the normal policy, synchronization, media-usage, cache-invalidation, and after-hook behavior.

`content:restore` separately adds `getTrashedVersioned()` and `restore()` without granting ordinary content reads. It does not grant permanent deletion.

Plugin actions report `{ source: "plugin", pluginId }`. Re-entering the same action for the same canonical entry from that plugin is rejected.

## Runtime tests

Use runtime fixtures for initial entries, translations, bylines, and taxonomy assignments. Use runtime actions for publication paths and inspectors for persisted state. Test stale revisions, policy rejection, duplicate locales, re-entrancy, restart, and cache invalidation when those behaviors matter.
