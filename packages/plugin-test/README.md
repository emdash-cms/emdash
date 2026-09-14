# @emdash-cms/plugin-test

Workerd-backed Vitest utilities for sandboxed EmDash plugins.

```ts
// vitest.config.ts
import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [emdashPluginTest()],
});
```

```ts
import { createPluginTestHost } from "@emdash-cms/plugin-test";

const host = await createPluginTestHost();
await host.invokeRoute("health");
await host.dispose();
```

The configuration builds the plugin and supplies local D1 and Worker Loader bindings through `@cloudflare/vitest-plugin`. The host loads the built code through EmDash's production Cloudflare sandbox runner and `PluginBridge`.

Read [Test sandboxed plugins](https://docs.emdashcms.com/plugins/creating-plugins/testing/) for hooks, content fixtures, storage assertions, and test boundaries.
