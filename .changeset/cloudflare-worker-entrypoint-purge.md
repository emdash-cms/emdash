---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fixes scheduled Workers Cache purges by adding the named `EmDashWorker` entrypoint for sites that re-export it as their default Worker export.

To enable the fix on an existing site, replace the object-style default export in `src/worker.ts` with this re-export:

```ts
export {
	EmDashWorker as default,
	EmDashRoom,
	EmDashRoomSite,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";
```

Sites with custom fetch or scheduled handling should extend `EmDashWorker`; see the [Cloudflare deployment documentation](https://docs.emdashcms.com/deployment/cloudflare/#a-custom-fetch-handler) for the `handleRoomUpgrade` and `createScheduledHandler()` delegation points. Custom scheduled handlers must pass `invalidateViaDefaultEntrypoint: true` to opt into RPC invalidation. The legacy object default export and direct `createScheduledHandler()` usage remain compatible, but scheduled Workers Cache purges require `EmDashWorker` as the site's default. `emdash doctor` recognizes the subclass form and recommends the RPC-capable entrypoint. Cache invalidation from co-editing rooms and the plugin bridge is unchanged.
