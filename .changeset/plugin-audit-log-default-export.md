---
"@emdash-cms/plugin-audit-log": minor
---

**BREAKING:** Removes the `auditLogPlugin` named export and the factory call shape. Import the default export and pass it directly into `plugins:` or `sandboxed:`.

```diff
- import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
+ import auditLog from "@emdash-cms/plugin-audit-log";

  export default defineConfig({
  	integrations: [
  		emdash({
- 			plugins: [auditLogPlugin()],
+ 			plugins: [auditLog],
  		}),
  	],
  });
```

Two changes: drop the `{ }` around the import, and drop the `()` after the plugin name. Per-install configuration moved to the admin UI's settings (KV-backed) when the sandboxed plugin redesign landed, so there's no longer a need for a factory call.
