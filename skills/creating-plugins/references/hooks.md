# Hooks

Sandboxed plugins declare hooks in the typed default export from `src/plugin.ts`. The `SandboxedPlugin` type infers each event and return type from the hook name.

## Signature

```typescript
async (event: EventType, ctx: PluginContext) => ReturnType;
```

## Configuration

Simple handler or full config:

```typescript
import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": {
			priority: 100,
			timeout: 5000,
			handler: async (event, ctx) => {
				ctx.log.info("Saved", { id: event.content.id });
			},
		},
	},
};

export default plugin;
```

The plugin CLI manifest retains `priority`, `timeout`, `dependencies`, `errorPolicy`, and `exclusive`. Registry-installed and config-managed sandbox hooks enter the shared host pipeline, so these settings apply consistently with trusted plugins.

Put capabilities in `emdash-plugin.jsonc`, not in `src/plugin.ts`. The host pipeline skips sandboxed and trusted hooks whose required capability is absent.

## Isolated sandbox support

The current isolated runtime dispatches these hooks to Cloudflare and Node/workerd sandbox instances through the shared host pipeline:

- `plugin:install`, `plugin:activate`, `plugin:deactivate`, and `plugin:uninstall`
- `content:beforeSave`, `content:afterSave`, `content:beforeDelete`, and `content:afterDelete`
- `content:afterPublish`, `content:afterUnpublish`, `content:afterRestore`, `content:afterSchedule`, and `content:afterUnschedule`
- `media:beforeUpload` and `media:afterUpload`
- `email:beforeSend`, `email:deliver`, and `email:afterSend`
- `comment:beforeCreate`, `comment:moderate`, `comment:afterCreate`, and `comment:afterModerate`
- `cron`
- `page:metadata`

`page:fragments` is the only declared hook excluded from sandbox registration. The plugin CLI accepts it and emits a trusted-only warning; the sandbox host proxy drops it before the hook pipeline is built.

## Lifecycle Hooks

### `plugin:install`

Runs once on first install. Use to seed defaults.

```typescript
"plugin:install": async (_event, ctx) => {
	await ctx.kv.set("settings:enabled", true);
	await ctx.storage.items!.put("default", { name: "Default" });
}
```

Event: `{}`
Returns: `void`

### `plugin:activate`

Runs when plugin is enabled (after install or re-enable).

```typescript
"plugin:activate": async (_event, ctx) => {
	ctx.log.info("Activated");
}
```

Event: `{}`
Returns: `void`

### `plugin:deactivate`

Runs when plugin is disabled (not removed).

```typescript
"plugin:deactivate": async (_event, ctx) => {
	ctx.log.info("Deactivated");
}
```

Event: `{}`
Returns: `void`

### `plugin:uninstall`

Runs when plugin is removed. Only delete data if `event.deleteData` is true.

```typescript
"plugin:uninstall": async (event, ctx) => {
	if (event.deleteData) {
		const result = await ctx.storage.items!.query({ limit: 1000 });
		await ctx.storage.items!.deleteMany(result.items.map(i => i.id));
	}
}
```

Event: `{ deleteData: boolean }`
Returns: `void`

## Content Hooks

### `content:beforeSave`

Runs before save. Return modified content, or void to keep it unchanged. To reject from the sandbox, return `{ __emdashSandboxHookResult: true, version: 1, error: { code: "SAVE_REJECTED", reason } }`. The reason must be 1–500 characters of plain text. EmDash identifies the plugin and shows the reason as text; invalid or unknown error results fail with a generic hook error. From the host process, throw `ContentSaveRejectedError` (exported from `emdash`) instead. Any other exception from either execution mode fails the save with a generic message.

```typescript
"content:beforeSave": async (event, ctx) => {
	const { content } = event;
	if (!content.title) {
		return {
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a title before saving." },
		};
	}

	// Transform
	if (content.slug) {
		content.slug = content.slug.toLowerCase().replace(/\s+/g, "-");
	}

	return content;
}
```

Event: `{ content: Record<string, unknown>, collection: string, isNew: boolean, id?: string, actor?: { id: string, role: number } }`. Authenticated REST, visual editing, and MCP saves include a read-only actor snapshot; internal writes may omit it. On updates, `id` identifies the existing item. The actor snapshot does not identify the request origin, so a hook cannot distinguish REST, visual editing, MCP, or another authenticated path from this field alone.
Returns: `Record<string, unknown> | SandboxHookErrorEnvelope | void`

### `content:afterSave`

Runs after successful save. Side effects only — logging, notifications, syncing.

```typescript
"content:afterSave": async (event, ctx) => {
	const { content, collection, isNew } = event;
	ctx.log.info(`${isNew ? "Created" : "Updated"} ${collection}/${content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string, isNew: boolean, actor?: { id: string, role: number } }`. Authenticated saves include a read-only actor snapshot; internal writes may omit it.
Returns: `void`

### `content:beforeDelete`

Runs before delete. Return `false` to cancel, `true` or void to allow.

```typescript
"content:beforeDelete": async (event, ctx) => {
	if (event.collection === "pages" && event.id === "home") {
		ctx.log.warn("Cannot delete home page");
		return false;
	}
	return true;
}
```

Event: `{ id: string, collection: string }`
Returns: `boolean | void`

### `content:afterDelete`

Runs after successful delete.

```typescript
"content:afterDelete": async (event, ctx) => {
	ctx.log.info(`Deleted ${event.collection}/${event.id}`);
	await ctx.storage.cache!.delete(`${event.collection}:${event.id}`);
}
```

Event: `{ id: string, collection: string }`
Returns: `void`

### `content:afterPublish`

Runs after content is published (promoted from draft to live). Side effects only.

```typescript
"content:afterPublish": async (event, ctx) => {
	ctx.log.info(`Published ${event.collection}/${event.content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string }`
Returns: `void`

### `content:afterUnpublish`

Runs after content is unpublished (reverted to draft). Side effects only.

```typescript
"content:afterUnpublish": async (event, ctx) => {
	ctx.log.info(`Unpublished ${event.collection}/${event.content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string }`
Returns: `void`

### `content:afterRestore`

Runs after trashed content is restored. Side effects only.

```typescript
"content:afterRestore": async (event, ctx) => {
	ctx.log.info(`Restored ${event.collection}/${event.content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string }`
Returns: `void`

### `content:afterSchedule`

Runs after content is scheduled for future publishing. Side effects only.

```typescript
"content:afterSchedule": async (event, ctx) => {
	ctx.log.info(`Scheduled ${event.collection}/${event.content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string }`
Returns: `void`

### `content:afterUnschedule`

Runs after scheduled content is unscheduled. Side effects only.

```typescript
"content:afterUnschedule": async (event, ctx) => {
	ctx.log.info(`Unscheduled ${event.collection}/${event.content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string }`
Returns: `void`

## Media Hooks

### `media:beforeUpload`

Runs before upload. Return modified file info, void to keep, or throw to cancel.

```typescript
"media:beforeUpload": async (event, ctx) => {
	const { file } = event;

	if (!file.type.startsWith("image/")) {
		throw new Error("Only images allowed");
	}

	if (file.size > 10 * 1024 * 1024) {
		throw new Error("Max 10MB");
	}

	return { ...file, name: `${Date.now()}-${file.name}` };
}
```

Event: `{ file: { name: string, type: string, size: number } }`
Returns: `{ name: string, type: string, size: number } | void`

### `media:afterUpload`

Runs after successful upload.

```typescript
"media:afterUpload": async (event, ctx) => {
	ctx.log.info(`Uploaded ${event.media.filename}`, { id: event.media.id });
}
```

Event: `{ media: { id: string, filename: string, mimeType: string, size: number | null, url: string, createdAt: string } }`
Returns: `void`

## Email Hooks

Email hooks require specific capabilities. Without the required capability, hooks are silently skipped.

### `email:beforeSend`

**Requires:** `hooks.email-events:register` capability.

Runs before email delivery. Return modified message, or `false` to cancel delivery. Handlers are chained — each receives the output of the previous one.

```typescript
// emdash-plugin.jsonc: "capabilities": ["hooks.email-events:register"]
"email:beforeSend": async (event) => {
	return { ...event.message, text: event.message.text + "\n\n-- Sent via EmDash" };
},
```

Event: `{ message: EmailMessage, source: string }`
Returns: `EmailMessage | false`

### `email:deliver`

**Requires:** `hooks.email-transport:register` capability. **Exclusive hook** — exactly one provider is active.

Implements email transport (e.g. Resend, SMTP, SES). Selected by the admin in Settings > Email.

```typescript
// emdash-plugin.jsonc declares hooks.email-transport:register and network:request,
// with api.resend.com in allowedHosts.
"email:deliver": {
	exclusive: true,
	handler: async ({ message }, ctx) => {
		const apiKey = await ctx.kv.get("settings:apiKey");
		await ctx.http!.fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
		});
	},
},
```

Event: `{ message: EmailMessage, source: string }`
Returns: `void`

### `email:afterSend`

**Requires:** `hooks.email-events:register` capability.

Runs after successful delivery. Fire-and-forget — errors are logged but don't propagate.

```typescript
// emdash-plugin.jsonc: "capabilities": ["hooks.email-events:register"]
"email:afterSend": async (event, ctx) => {
	ctx.log.info(`Email sent to ${event.message.to}`, { source: event.source });
},
```

Event: `{ message: EmailMessage, source: string }`
Returns: `void`

## Comment hooks

Comment hooks run for sandboxed and trusted plugins through the shared pipeline. All four require `users:read`. Their events include author email and request-derived information, so the pipeline skips the hook when the capability is absent.

### `comment:beforeCreate`

Runs before storage. Return a modified event to enrich the comment or its moderator-only metadata, return `false` to reject the comment, or return nothing to keep it unchanged.

```typescript
"comment:beforeCreate": async (event) => {
	if (event.comment.body.includes("blocked phrase")) return false;
	return {
		...event,
		metadata: { ...event.metadata, reviewedBy: "rules-v1" },
	};
},
```

Event:

```typescript
{
	comment: {
		collection: string;
		contentId: string;
		parentId: string | null;
		authorName: string;
		authorEmail: string;
		authorUserId: string | null;
		body: string;
		ipHash: string | null;
		userAgent: string | null;
	}
	metadata: Record<string, unknown>;
}
```

Returns: the event, `false`, or `void`.

### `comment:moderate`

The exclusive moderation provider decides the initial status after the enrichment pipeline.

```typescript
"comment:moderate": {
	exclusive: true,
	handler: async (event) => ({
		status: event.priorApprovedCount > 0 ? "approved" : "pending",
		reason: "First-time authors require review",
	}),
},
```

The event contains `comment`, `metadata`, collection comment settings, and `priorApprovedCount`. Return `{ status: "approved" | "pending" | "spam", reason?: string }`.

### `comment:afterCreate`

Runs after the comment is stored. The event contains the stored comment, moderation metadata, the target content summary, and the content author when available. Use it for notifications and other side effects. Returns `void`.

### `comment:afterModerate`

Runs after an administrator or a plugin changes a comment's status. The event contains the stored comment, `previousStatus`, `newStatus`, the moderator's `{ id, name }`, and `origin`. Administrator changes use `{ source: "admin", userId }`; `ctx.comments.setStatus()` uses `{ source: "plugin", pluginId }`. A transition runs the hook once. Returns `void`.

## Cron Hook

### `cron`

Runs on a schedule. Configure schedules via `ctx.cron.schedule()` in `plugin:activate`.

```typescript
hooks: {
	"plugin:activate": async (_event, ctx) => {
		await ctx.cron!.schedule("daily-cleanup", { schedule: "0 2 * * *" });
	},
	cron: async (event, ctx) => {
		if (event.name === "daily-cleanup") {
			// ... cleanup logic
		}
	},
},
```

Event: `{ name: string, data?: Record<string, unknown> }`
Returns: `void`

## Public Page Hooks

Public page hooks let plugins contribute to the rendered output of public site pages. Templates opt in to these contributions with `<EmDashHead>`, `<EmDashBodyStart>`, and `<EmDashBodyEnd>` components.

### `page:metadata`

Contributes typed metadata to `<head>` — meta tags, OG properties, canonical/alternate links, and JSON-LD. Works in both trusted and sandboxed modes.

Returns structured contributions that core validates, dedupes (first-wins), and renders. Plugins never emit raw HTML through this hook.

```typescript
"page:metadata": async (event, ctx) => {
	if (event.page.kind !== "content") return null;

	return [
		{ kind: "meta", name: "author", content: "My Blog" },
		{
			kind: "jsonld",
			id: `schema:${event.page.content?.collection}:${event.page.content?.id}`,
			graph: {
				"@context": "https://schema.org",
				"@type": "BlogPosting",
				headline: event.page.pageTitle ?? event.page.title,
				description: event.page.description,
			},
		},
	];
}
```

Event: `{ page: PublicPageContext }`
Returns: `PageMetadataContribution | PageMetadataContribution[] | null`

Contribution types:

- `{ kind: "meta", name: string, content: string, key?: string }` — `<meta name="..." content="...">`
- `{ kind: "property", property: string, content: string, key?: string }` — `<meta property="..." content="...">` (OpenGraph)
- `{ kind: "link", rel: "canonical" | "alternate", href: string, hreflang?: string, key?: string }` — `<link>` tag (HTTP/HTTPS URLs only)
- `{ kind: "jsonld", id?: string, graph: object | object[] }` — `<script type="application/ld+json">`

Dedupe rules: first contribution wins per key. Canonical is singleton.

### `page:fragments` (trusted only)

Contributes raw HTML, scripts, or markup to `head`, `body:start`, or `body:end`. The sandbox authoring type and manifest schema accept the declaration, and the plugin CLI warns that it is trusted-only. The sandbox host proxy excludes the hook, so a registry-installed plugin never contributes these fragments.

```typescript
"page:fragments": async (event, ctx) => {
	return [
		{
			kind: "external-script",
			placement: "head",
			src: "https://www.googletagmanager.com/gtm.js?id=GTM-XXXXX",
			async: true,
		},
		{
			kind: "html",
			placement: "body:start",
			html: '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXXX" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>',
		},
	];
}
```

Event: `{ page: PublicPageContext }`
Returns: `PageFragmentContribution | PageFragmentContribution[] | null`

Contribution types:

- `{ kind: "external-script", placement, src, async?, defer?, attributes?, key? }`
- `{ kind: "inline-script", placement, code, attributes?, key? }`
- `{ kind: "html", placement, html, key? }`

Placements: `"head"`, `"body:start"`, `"body:end"`

## Execution Order

1. Lower `priority` values run first
2. Equal priorities: plugin registration order
3. `dependencies` forces a hook to wait for the named plugins regardless of priority

These ordering rules apply to sandboxed and trusted hooks in the shared host pipeline.

## Error Handling

- `errorPolicy: "abort"` (default) — pipeline stops, operation may fail
- `errorPolicy: "continue"` — error logged, remaining hooks still run

These policies apply to sandboxed and trusted hooks in the shared host pipeline.

## Quick Reference

| Hook                      | Trigger              | Capability Required                           | Return                                                  |
| ------------------------- | -------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `plugin:install`          | First install        | —                                             | `void`                                                  |
| `plugin:activate`         | Plugin enabled       | —                                             | `void`                                                  |
| `plugin:deactivate`       | Plugin disabled      | —                                             | `void`                                                  |
| `plugin:uninstall`        | Plugin removed       | —                                             | `void`                                                  |
| `content:beforeSave`      | Before save          | `content:write`                               | Modified content, `SandboxHookErrorEnvelope`, or `void` |
| `content:afterSave`       | After save           | `content:read`                                | `void`                                                  |
| `content:beforeDelete`    | Before delete        | `content:read`                                | `false` to cancel                                       |
| `content:afterDelete`     | After delete         | `content:read`                                | `void`                                                  |
| `content:afterPublish`    | After publish        | `content:read`                                | `void`                                                  |
| `content:afterUnpublish`  | After unpublish      | `content:read`                                | `void`                                                  |
| `content:afterRestore`    | After restore        | `content:read`                                | `void`                                                  |
| `content:afterSchedule`   | After schedule       | `content:read`                                | `void`                                                  |
| `content:afterUnschedule` | After unschedule     | `content:read`                                | `void`                                                  |
| `media:beforeUpload`      | Before upload        | `media:write`                                 | Modified file info or `void`                            |
| `media:afterUpload`       | After upload         | `media:read`                                  | `void`                                                  |
| `email:beforeSend`        | Before email send    | `hooks.email-events:register`                 | Modified message or `false`                             |
| `email:deliver`           | Email delivery       | `hooks.email-transport:register`              | `void` (exclusive)                                      |
| `email:afterSend`         | After email send     | `hooks.email-events:register`                 | `void`                                                  |
| `comment:beforeCreate`    | Before comment save  | `users:read`                                  | Modified event, `false`, or `void`                      |
| `comment:moderate`        | Initial moderation   | `users:read`                                  | Moderation decision (exclusive)                         |
| `comment:afterCreate`     | After comment save   | `users:read`                                  | `void`                                                  |
| `comment:afterModerate`   | After status change  | `users:read`                                  | `void`                                                  |
| `cron`                    | Scheduled task fires | —                                             | `void`                                                  |
| `page:metadata`           | Page render          | —                                             | Metadata contributions                                  |
| `page:fragments`          | Page render          | `hooks.page-fragments:register` (native only) | Fragment contributions                                  |
