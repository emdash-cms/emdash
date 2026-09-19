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

`createPluginTestHost()` is a transport-level isolate harness. Use `createPluginRuntimeTestHost()` when a test must trigger a real EmDash action and inspect the resulting state:

```ts
import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const host = await createPluginRuntimeTestHost();
await host.fixtures.collection({ slug: "posts", label: "Posts" });
const result = await host.actions.content.create("posts", { data: {} });
if (!result.success) throw new Error(result.error.message);
await host.restart();
await host.inspect.content.get("posts", result.data.item.id);
await host.inspect.scheduledPolicyRejections();
await host.dispose();
```

The configuration builds the plugin and supplies local D1 and Worker Loader bindings through `@cloudflare/vitest-plugin`. Both hosts load the built code through EmDash's production Cloudflare sandbox runner and `PluginBridge`. The runtime host separates direct transport calls, fixtures, production actions, inspectors, scheduled time control, restart, and disposal.

Read [Test sandboxed plugins](https://docs.emdashcms.com/plugins/creating-plugins/testing/) for hooks, content fixtures, storage assertions, and test boundaries.
