---
"@emdash-cms/plugin-webhook-notifier": minor
---

**BREAKING:** Removes the `webhookNotifierPlugin` named export and the factory call shape. Import the default export and pass it directly into `plugins:` or `sandboxed:`.

**Before:**

```ts
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";

export default defineConfig({
	integrations: [
		emdash({
			sandboxed: [webhookNotifierPlugin()],
		}),
	],
});
```

**After:**

```ts
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";

export default defineConfig({
	integrations: [
		emdash({
			sandboxed: [webhookNotifier],
		}),
	],
});
```

Two changes: drop the `{ }` around the import, and drop the `()` after the plugin name. Per-install configuration moved to the admin UI's settings (KV-backed) when the sandboxed plugin redesign landed, so there's no longer a need for a factory call.
