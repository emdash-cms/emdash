/**
 * `emdash/plugin` — types for authoring sandboxed plugins.
 *
 * This is a **type-only** subpath. The package.json export map only
 * declares a `types` condition, so the bundler erases `import type`
 * statements against this entry and the build never tries to resolve a
 * JavaScript module. That's how a sandboxed plugin can import these
 * types without dragging the `emdash` runtime into its bundle.
 *
 * Recommended authoring pattern:
 *
 * ```ts
 * import type { SandboxedPlugin } from "emdash/plugin";
 *
 * export default {
 *   hooks: {
 *     "content:beforeSave": async (event, ctx) => {
 *       // event: ContentHookEvent, ctx: PluginContext — both inferred.
 *       return event.content;
 *     },
 *   },
 *   routes: {
 *     health: async (routeCtx, ctx) => ({ ok: true }),
 *   },
 * } satisfies SandboxedPlugin;
 * ```
 *
 * The `satisfies SandboxedPlugin` annotation drives full inference on
 * every hook handler. Authors should not need to annotate handler
 * params — TypeScript reads the event type from the hook name. The
 * runtime probe at build time reads `default.hooks` and `default.routes`
 * directly; the shape declared here mirrors what the probe consumes.
 *
 * Return types matter: `content:beforeSave` may return a mutated
 * `content` to override the saved fields; `content:beforeDelete` and
 * `comment:beforeCreate` may return `false` to veto; `page:metadata`
 * returns the metadata contribution. The mapped type captures these
 * per-hook return contracts so misuse fails at compile time.
 */

import type { ManifestJsonObjectSchema } from "@emdash-cms/plugin-types";

import type {
	CommentAfterCreateEvent,
	CommentAfterCreateHandler,
	CommentAfterModerateEvent,
	CommentAfterModerateHandler,
	CommentBeforeCreateEvent,
	CommentBeforeCreateHandler,
	CommentModerateEvent,
	CommentModerateHandler,
	ContentAfterDeleteHandler,
	ContentAfterPublishHandler,
	ContentAfterSaveHandler,
	ContentAfterUnpublishHandler,
	ContentBeforeDeleteHandler,
	ContentBeforeSaveHandler,
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	CronEvent,
	CronHandler,
	EmailAfterSendEvent,
	EmailAfterSendHandler,
	EmailBeforeSendEvent,
	EmailBeforeSendHandler,
	EmailDeliverEvent,
	EmailDeliverHandler,
	LifecycleEvent,
	LifecycleHandler,
	MediaAfterUploadEvent,
	MediaAfterUploadHandler,
	MediaBeforeUploadHandler,
	MediaUploadEvent,
	PageFragmentEvent,
	PageFragmentHandler,
	PageMetadataEvent,
	PageMetadataHandler,
	PluginContext,
	UninstallEvent,
	UninstallHandler,
} from "./plugins/types.js";

/**
 * Map from hook name to its handler signature. Adding or changing a
 * hook signature in the runtime means updating this map; the rest of
 * the type story flows from it. Authors writing
 * `"content:beforeSave": async (event, ctx) => { ... }` get `event`
 * typed as `ContentHookEvent` and `ctx` as `PluginContext` for free.
 */
export interface HookHandlers {
	"plugin:install": LifecycleHandler;
	"plugin:activate": LifecycleHandler;
	"plugin:deactivate": LifecycleHandler;
	"plugin:uninstall": UninstallHandler;
	"content:beforeSave": ContentBeforeSaveHandler;
	"content:afterSave": ContentAfterSaveHandler;
	"content:beforeDelete": ContentBeforeDeleteHandler;
	"content:afterDelete": ContentAfterDeleteHandler;
	"content:afterPublish": ContentAfterPublishHandler;
	"content:afterUnpublish": ContentAfterUnpublishHandler;
	"media:beforeUpload": MediaBeforeUploadHandler;
	"media:afterUpload": MediaAfterUploadHandler;
	cron: CronHandler;
	"email:beforeSend": EmailBeforeSendHandler;
	"email:deliver": EmailDeliverHandler;
	"email:afterSend": EmailAfterSendHandler;
	"comment:beforeCreate": CommentBeforeCreateHandler;
	"comment:moderate": CommentModerateHandler;
	"comment:afterCreate": CommentAfterCreateHandler;
	"comment:afterModerate": CommentAfterModerateHandler;
	"page:metadata": PageMetadataHandler;
	"page:fragments": PageFragmentHandler;
}

/**
 * Hook-handler config form. The bare-function form is also accepted
 * (see `HookEntry`) — this is the long form that lets authors override
 * priority, timeout, exclusivity. `errorPolicy` and `dependencies` are
 * read by the host but rarely set by authors.
 */
export interface HookConfig<K extends keyof HookHandlers> {
	handler: HookHandlers[K];
	priority?: number;
	timeout?: number;
	dependencies?: string[];
	errorPolicy?: "continue" | "abort";
	exclusive?: boolean;
}

/**
 * Either a bare handler or the config form. The build probe accepts
 * both shapes and the runtime normalises to the config form before
 * dispatch.
 */
export type HookEntry<K extends keyof HookHandlers> = HookHandlers[K] | HookConfig<K>;

/**
 * Request fields a route handler can rely on across both trusted and
 * sandboxed execution. Trusted handlers receive a real `Request`
 * (which is structurally compatible — has `url`, `method`, `headers`);
 * sandboxed handlers receive a serialised `{ url, method, headers }`
 * record because Worker Loader can't pass `Request` objects across
 * the boundary. The shared shape is what's actually portable.
 *
 * `headers` is intentionally `Record<string, string>` rather than
 * `Headers` so the sandboxed serialised form (which is a plain
 * record) typechecks. Trusted handlers receiving a real `Headers`
 * object can still call `.get(...)`, but reading via this type's
 * indexing requires the lookup to be lowercased and exact. Authors
 * iterating headers in a portable way should use `Object.entries`.
 */
export interface SandboxedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
}

/**
 * Context passed to a route handler. Routes get an extra `routeCtx`
 * argument with the call-site input + the originating request, in
 * addition to the standard `PluginContext`.
 *
 * `input` is `unknown` because plugins validate it themselves — no
 * central schema for route payloads.
 */
export interface SandboxedRouteContext {
	input: unknown;
	request: SandboxedRequest;
	requestMeta?: unknown;
}

/**
 * Route handler. The two-arg shape (`routeCtx`, `pluginCtx`) matches
 * how the standard-format runtime invokes routes — distinct from
 * native plugins, where routes take a single context with the input
 * merged in.
 *
 * Return type is `unknown` because routes serialise their return value
 * to JSON for the caller; authors define their own response shape.
 */
export type RouteHandler = (
	routeCtx: SandboxedRouteContext,
	ctx: PluginContext,
) => Promise<unknown>;

/**
 * Route entry — either a bare handler or the config form with
 * `public`, `input` schema, and so on. The build probe accepts both.
 */
export type RouteEntry =
	| RouteHandler
	| {
			handler: RouteHandler;
			public?: boolean;
			input?: unknown;
	  };

/**
 * MCP tool entry declared by a sandboxed plugin's default export.
 *
 * Execution is delegated to a plugin route. `input` is the optional
 * trusted-mode Zod schema used at runtime; `inputSchema` is the portable
 * JSON Schema object emitted to manifests for MCP client introspection.
 */
export interface SandboxedMcpToolEntry {
	title?: string;
	description: string;
	route: string;
	input?: unknown;
	inputSchema?: ManifestJsonObjectSchema;
}

/**
 * The shape of a sandboxed plugin's default export.
 *
 * Both `hooks` and `routes` are optional — a plugin that only declares
 * one is valid. Hook keys are constrained to the runtime's hook
 * vocabulary so a typo (`"content:beforSave"`) is a compile error.
 * Route keys are open because route names are author-chosen URL path
 * segments.
 */
export interface SandboxedPlugin {
	hooks?: {
		[K in keyof HookHandlers]?: HookEntry<K>;
	};
	routes?: Record<string, RouteEntry>;
	mcpTools?: Record<string, SandboxedMcpToolEntry>;
}

/**
 * Re-export of event types so plugin authors can reference them
 * explicitly when needed (helper functions, type predicates). Most
 * authors won't need these — the mapped type infers them at handler
 * call sites. But the default-export's inferred type also needs them
 * publicly nameable so `satisfies SandboxedPlugin` can produce a
 * portable `.d.mts`.
 */
export type {
	CommentAfterCreateEvent,
	CommentAfterModerateEvent,
	CommentBeforeCreateEvent,
	CommentModerateEvent,
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	CronEvent,
	EmailAfterSendEvent,
	EmailBeforeSendEvent,
	EmailDeliverEvent,
	LifecycleEvent,
	MediaAfterUploadEvent,
	MediaUploadEvent,
	PageFragmentEvent,
	PageMetadataEvent,
	PluginContext,
	UninstallEvent,
};
