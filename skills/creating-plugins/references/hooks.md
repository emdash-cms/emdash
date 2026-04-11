# Hooks Reference

Hooks let plugins run code in response to events. Declared in `definePlugin({ hooks })`.

## Signature

```typescript
async (event: EventType, ctx: PluginContext) => ReturnType;
```

## Configuration

Simple handler or full config:

```typescript
// Simple
hooks: {
	"content:afterSave": async (event, ctx) => {
		ctx.log.info("Saved");
	}
}

// Full config
hooks: {
	"content:afterSave": {
		priority: 100,      // Lower runs first (default: 100)
		timeout: 5000,      // Max execution time ms (default: 5000)
		dependencies: [],   // Plugin IDs that must run first
		errorPolicy: "abort", // "abort" | "continue"
		handler: async (event, ctx) => {
			ctx.log.info("Saved");
		}
	}
}
```

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

Runs before save. Return modified content, void to keep unchanged, or throw to cancel.

```typescript
"content:beforeSave": async (event, ctx) => {
	const { content, collection, isNew } = event;

	if (collection === "posts" && !content.title) {
		throw new Error("Posts require a title");
	}

	// Transform
	if (content.slug) {
		content.slug = content.slug.toLowerCase().replace(/\s+/g, "-");
	}

	return content;
}
```

Event: `{ content: Record<string, unknown>, collection: string, isNew: boolean }`
Returns: `Record<string, unknown> | void`

### `content:afterSave`

Runs after successful save. Side effects only — logging, notifications, syncing.

```typescript
"content:afterSave": async (event, ctx) => {
	const { content, collection, isNew } = event;
	ctx.log.info(`${isNew ? "Created" : "Updated"} ${collection}/${content.id}`);
}
```

Event: `{ content: Record<string, unknown>, collection: string, isNew: boolean }`
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

**Requires:** `email:intercept` capability.

Runs before email delivery. Return modified message, or `false` to cancel delivery. Handlers are chained — each receives the output of the previous one.

```typescript
definePlugin({
	id: "email-footer",
	capabilities: ["email:intercept"],
	hooks: {
		"email:beforeSend": async (event, ctx) => {
			return { ...event.message, text: event.message.text + "\n\n-- Sent via EmDash" };
		},
	},
});
```

Event: `{ message: EmailMessage, source: string }`
Returns: `EmailMessage | false`

### `email:deliver`

**Requires:** `email:provide` capability. **Exclusive hook** — exactly one provider is active.

Implements email transport (e.g. Resend, SMTP, SES). Selected by the admin in Settings > Email.

```typescript
definePlugin({
	id: "emdash-resend",
	capabilities: ["email:provide", "network:fetch"],
	allowedHosts: ["api.resend.com"],
	hooks: {
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
	},
});
```

Event: `{ message: EmailMessage, source: string }`
Returns: `void`

### `email:afterSend`

**Requires:** `email:intercept` capability.

Runs after successful delivery. Fire-and-forget — errors are logged but don't propagate.

```typescript
definePlugin({
	id: "email-logger",
	capabilities: ["email:intercept"],
	hooks: {
		"email:afterSend": async (event, ctx) => {
			ctx.log.info(`Email sent to ${event.message.to}`, { source: event.source });
		},
	},
});
```

Event: `{ message: EmailMessage, source: string }`
Returns: `void`

## Cron Hook

### `cron`

Runs on a schedule. Configure schedules via `ctx.cron.schedule()` in `plugin:activate`.

```typescript
definePlugin({
	id: "cleanup",
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
});
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

### `page:fragments` (Trusted Only)

Contributes raw HTML, scripts, or markup to `head`, `body:start`, or `body:end`. **Trusted plugins only.** Sandboxed plugins cannot register this hook — the manifest schema rejects it.

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
3. `dependencies` array forces ordering regardless of priority

## Error Handling

- `errorPolicy: "abort"` (default) — pipeline stops, operation may fail
- `errorPolicy: "continue"` — error logged, remaining hooks still run

Use `"continue"` for non-critical operations (analytics, notifications, external syncs).

## Quick Reference

| Hook                     | Trigger              | Capability Required | Return                       |
| ------------------------ | -------------------- | ------------------- | ---------------------------- |
| `plugin:install`         | First install        | —                   | `void`                       |
| `plugin:activate`        | Plugin enabled       | —                   | `void`                       |
| `plugin:deactivate`      | Plugin disabled      | —                   | `void`                       |
| `plugin:uninstall`       | Plugin removed       | —                   | `void`                       |
| `content:beforeSave`     | Before save          | —                   | Modified content or `void`   |
| `content:afterSave`      | After save           | —                   | `void`                       |
| `content:beforeDelete`   | Before delete        | —                   | `false` to cancel            |
| `content:afterDelete`    | After delete         | —                   | `void`                       |
| `content:afterPublish`   | After publish        | —                   | `void`                       |
| `content:afterUnpublish` | After unpublish      | —                   | `void`                       |
| `media:beforeUpload`     | Before upload        | —                   | Modified file info or `void` |
| `media:afterUpload`      | After upload         | —                   | `void`                       |
| `email:beforeSend`       | Before email send    | `email:intercept`   | Modified message or `false`  |
| `email:deliver`          | Email delivery       | `email:provide`     | `void` (exclusive)           |
| `email:afterSend`        | After email send     | `email:intercept`   | `void`                       |
| `cron`                   | Scheduled task fires | —                   | `void`                       |
| `page:metadata`          | Page render          | —                   | Metadata contributions       |
| `page:fragments`         | Page render          | — (trusted only)    | Fragment contributions       |
