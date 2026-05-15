---
"@emdash-cms/plugin-atproto": minor
---

**BREAKING:** Removes the `atprotoPlugin` named export and the factory call shape. Import the default export and pass it directly into `plugins:` or `sandboxed:`.

**Before:**

```ts
import { atprotoPlugin } from "@emdash-cms/plugin-atproto";

export default defineConfig({
	integrations: [
		emdash({
			sandboxed: [atprotoPlugin()],
		}),
	],
});
```

**After:**

```ts
import atproto from "@emdash-cms/plugin-atproto";

export default defineConfig({
	integrations: [
		emdash({
			sandboxed: [atproto],
		}),
	],
});
```

Two changes: drop the `{ }` around the import, and drop the `()` after the plugin name. Per-install configuration moved to the admin UI's settings (KV-backed) when the sandboxed plugin redesign landed, so there's no longer a need for a factory call.
