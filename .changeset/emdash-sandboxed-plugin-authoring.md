---
"emdash": minor
---

**BREAKING (plugin authors):** Reworks how sandboxed plugins are defined. The `definePlugin()` helper is removed for sandboxed-format plugins; the new shape is a bare default export with a `satisfies SandboxedPlugin` annotation. A new type-only subpath `emdash/plugin` provides the types.

This affects anyone _writing_ a sandboxed plugin. Sites that _use_ plugins are unaffected (see the per-plugin changesets for the import-shape change in published plugins).

```diff
- import { definePlugin, type ContentHookEvent, type PluginContext } from "emdash";
+ import type { SandboxedPlugin } from "emdash/plugin";

- export default definePlugin({
+ export default {
     hooks: {
         "content:beforeSave": {
-			handler: async (event: ContentHookEvent, ctx: PluginContext) => {
+			handler: async (event, ctx) => {
                 // ...
                 return event.content;
             },
         },
     },
- });
+ } satisfies SandboxedPlugin;
```

Three changes:

1. **Drop `import { definePlugin } from "emdash"`** and the `definePlugin(...)` wrapping call. Sandboxed plugins now default-export the bare object.
2. **`import type { SandboxedPlugin } from "emdash/plugin"`** and add `satisfies SandboxedPlugin` to the default export. The `emdash/plugin` subpath is type-only — the bundler erases the import, so no runtime resolution of `emdash` is needed (and the heavy `emdash` runtime no longer enters the plugin bundle).
3. **Drop handler parameter annotations** like `event: ContentSaveEvent, ctx: PluginContext`. The strict mapped type on `SandboxedPlugin` infers them per hook name, with the full canonical event type. If you need to reference an event type by name (e.g. in a helper function), `emdash/plugin` re-exports them: `import type { ContentHookEvent, PluginContext } from "emdash/plugin"`.

**Why:** the old `definePlugin` was an identity function whose only job was to alias `emdash` to a Proxy shim at build time so the import would resolve. With the new shape, sandboxed plugins have _no_ runtime `emdash` import — only type-only imports from `emdash/plugin`. The bundler doesn't need to alias anything; the build pipeline is simpler; and authors get strict per-hook event/return type inference for free.

The trade-off: previously you could narrow an event type locally (e.g. `interface ContentSaveEvent { content: ... & { id: string } }`). Under the strict mapped type, the canonical event type wins (TypeScript's contravariance on function parameters means narrowing isn't assignable). Authors validate fields at runtime with `typeof` / `isRecord` checks instead — which is the right pattern for input that comes from outside the type system anyway.

**Routes** follow the same simplification. The two-arg `(routeCtx, ctx)` shape is unchanged; only the annotations disappear:

```ts
export default {
	routes: {
		health: async (routeCtx, ctx) => {
			// routeCtx: SandboxedRouteContext, ctx: PluginContext — both inferred.
			return new Response("ok");
		},
	},
} satisfies SandboxedPlugin;
```

`SandboxedRouteContext` exposes `{ input, request, requestMeta? }`. `request` is typed as `SandboxedRequest` — a `{ url, method, headers }` record that's portable across in-process and isolate execution (Worker Loader can't pass real `Request` objects across the boundary).

**Native plugins are unaffected.** This change applies only to sandboxed-format plugins. Native plugins continue to use `definePlugin()` from `emdash` and the existing `PluginDefinition` shape.

**Type rename:** `SandboxedPlugin` on the `emdash` package now refers to the new author-facing source-shape type. The runtime-side handle type (returned by `SandboxRunner.load`, held in the runtime's plugin cache) is renamed to `SandboxedPluginInstance`. If you import `SandboxedPlugin` from `emdash` to type a sandbox runner implementation or hold runtime plugin handles, update those imports to `SandboxedPluginInstance`. Public consumers of this type are mostly limited to `@emdash-cms/cloudflare` and other sandbox runner adapters; standard plugin / site code is unaffected.

**Removed types:** `StandardPluginDefinition`, `StandardHookHandler`, `StandardHookEntry`, `StandardRouteHandler`, `StandardRouteEntry` are no longer exported from `emdash`. These were authoring-helper aliases under the old permissive `definePlugin` standard overload. Use `SandboxedPlugin` from `emdash/plugin` for the same purpose under the new shape.

**Removed function:** `isStandardPluginDefinition` is gone. There's no equivalent — sandboxed plugins are identified by structure (`{ hooks?, routes? }`) and you should treat the default export as already typed via `satisfies SandboxedPlugin`.
