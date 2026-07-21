/**
 * In-Process Adapter for Standard-Format Plugins
 *
 * Converts a standard plugin definition ({ hooks, routes }) into a
 * ResolvedPlugin compatible with HookPipeline. This allows standard-format
 * plugins to run in-process when placed in the `plugins: []` config array.
 *
 * The adapter wraps each hook and route handler so that the PluginContextFactory
 * provides the same capability-gated context as the native path.
 *
 */

import type { PluginDescriptor } from "../astro/integration/runtime.js";
import type { RouteEntry, RouteHandler, SandboxedPlugin } from "../plugin-types.js";
import { PLUGIN_CAPABILITIES, HOOK_NAMES } from "./manifest-schema.js";
import { normalizeCapabilities } from "./types.js";
import type {
	ResolvedPlugin,
	ResolvedPluginHooks,
	ResolvedHook,
	PluginRoute,
	PluginCapability,
	PluginStorageConfig,
	PluginAdminConfig,
} from "./types.js";

/**
 * Loose per-hook entry shape used inside the adapter's iteration loop.
 *
 * `SandboxedPlugin.hooks` is a mapped type keyed by hook name, so each
 * entry's type depends on the key. When the adapter iterates with
 * `Object.entries`, the key is `string` (TypeScript can't see the
 * narrowing), so we need a *union* type that covers every hook entry
 * shape — bare handler or config form. This is that union, kept local
 * because it has no use outside the adapter.
 */
// eslint-disable-next-line typescript-eslint/no-explicit-any -- must accept handlers with specific event types across all hook names
type AnyHookHandler = (...args: any[]) => Promise<any>;
type AnyHookEntry =
	| AnyHookHandler
	| {
			handler: AnyHookHandler;
			priority?: number;
			timeout?: number;
			dependencies?: string[];
			errorPolicy?: "continue" | "abort";
			exclusive?: boolean;
	  };

/**
 * Default hook configuration values
 */
const DEFAULT_PRIORITY = 100;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_ERROR_POLICY = "abort" as const;

/**
 * Check if a hook entry is the config form (has a `handler` property).
 */
function isHookConfig(entry: AnyHookEntry): entry is Exclude<AnyHookEntry, AnyHookHandler> {
	return typeof entry === "object" && entry !== null && "handler" in entry;
}

/**
 * Resolve a single hook entry to a ResolvedHook.
 *
 * Sandboxed-format hooks use the standard two-arg convention:
 *   handler(event, ctx)
 *
 * The HookPipeline dispatch methods also call handlers with (event, ctx),
 * so the handler is compatible as-is — we just normalise the
 * surrounding config (priority, timeout, etc.) to its defaults.
 */
function resolveSandboxedHook(entry: AnyHookEntry, pluginId: string): ResolvedHook<AnyHookHandler> {
	if (isHookConfig(entry)) {
		return {
			priority: entry.priority ?? DEFAULT_PRIORITY,
			timeout: entry.timeout ?? DEFAULT_TIMEOUT,
			dependencies: entry.dependencies ?? [],
			errorPolicy: entry.errorPolicy ?? DEFAULT_ERROR_POLICY,
			exclusive: entry.exclusive ?? false,
			handler: entry.handler,
			pluginId,
		};
	}

	// Bare function handler
	return {
		priority: DEFAULT_PRIORITY,
		timeout: DEFAULT_TIMEOUT,
		dependencies: [],
		errorPolicy: DEFAULT_ERROR_POLICY,
		exclusive: false,
		handler: entry,
		pluginId,
	};
}

/**
 * Normalise a `RouteEntry` (bare handler or `{ handler, public?, input? }`
 * config) to the config form. The `input` schema is intentionally typed
 * `unknown` in `RouteEntry` — sandboxed plugins describe it loosely
 * because the strict `z.ZodType<TInput>` constraint of the runtime's
 * `PluginRoute` only narrows once the route is wired into the router.
 * The wider type flows through to the runtime which validates at
 * invocation time.
 */
function normalizeRouteEntry(entry: RouteEntry): {
	handler: RouteHandler;
	public?: boolean;
	cacheControl?: string;
	input?: PluginRoute["input"];
	permission?: PluginRoute["permission"];
} {
	if (typeof entry === "function") {
		return { handler: entry };
	}
	return {
		handler: entry.handler,
		public: entry.public,
		permission: entry.permission,
		cacheControl: entry.cacheControl,
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- RouteEntry.input is intentionally `unknown` (sandboxed plugins) and validated by the runtime at invocation time
		input: entry.input as PluginRoute["input"],
	};
}

const VALID_CAPABILITIES_SET = new Set<string>(PLUGIN_CAPABILITIES);

const VALID_HOOK_NAMES_SET = new Set<string>(HOOK_NAMES);

/**
 * Adapt a sandboxed plugin's default export into a ResolvedPlugin.
 *
 * This is the in-process side of sandboxed-format plugins: it takes
 * the `{ hooks, routes }` default export of a sandboxed plugin and
 * produces a `ResolvedPlugin` that enters the HookPipeline alongside
 * native plugins. The descriptor supplies identity (id, version) and
 * the trust contract (capabilities, allowedHosts, storage); the
 * definition supplies behaviour.
 *
 * @param definition - The plugin's default export (matching `SandboxedPlugin` from `emdash/plugin`).
 * @param descriptor - The plugin descriptor with id, version, capabilities, etc.
 * @returns A ResolvedPlugin compatible with HookPipeline.
 */
export function adaptSandboxEntry(
	definition: SandboxedPlugin,
	descriptor: PluginDescriptor,
): ResolvedPlugin {
	const pluginId = descriptor.id;
	const version = descriptor.version;

	// A null / array / non-object `definition` would throw a generic
	// `TypeError: Cannot read properties of null` further down the
	// loop without the plugin id; surface a useful error first.
	if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
		throw new Error(
			`Plugin "${pluginId}" default export must be an object with ` +
				`\`hooks\` and/or \`routes\` (got ${
					Array.isArray(definition) ? "array" : typeof definition
				}). Did you forget \`export default {...} satisfies SandboxedPlugin\`?`,
		);
	}

	// Resolve hooks. `SandboxedPlugin.hooks` is keyed by hook name with
	// per-key entry types; iterating with `Object.entries` collapses
	// keys to `string`, so we treat each entry as the union `AnyHookEntry`
	// for the duration of the loop. The widening from the strict mapped
	// type to a plain record is sound because each entry still matches
	// one of the bare-handler / config-object shapes captured by
	// `AnyHookEntry`.
	const resolvedHooks: ResolvedPluginHooks = {};
	if (definition.hooks) {
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- widening the strict mapped type to a string-keyed record for iteration; entries still match AnyHookEntry
		const hookMap = definition.hooks as Record<string, AnyHookEntry>;
		for (const [hookName, entry] of Object.entries(hookMap)) {
			if (!VALID_HOOK_NAMES_SET.has(hookName)) {
				throw new Error(
					`Plugin "${pluginId}" declares unknown hook "${hookName}". ` +
						`Valid hooks: ${[...VALID_HOOK_NAMES_SET].join(", ")}`,
				);
			}
			// The resolved hook has the correct handler type for the hook name.
			// We store it as the generic type and let HookPipeline's typed dispatch
			// methods handle the type narrowing at call time.
			// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- bridging untyped map to typed interface
			(resolvedHooks as Record<string, unknown>)[hookName] = resolveSandboxedHook(entry, pluginId);
		}
	}

	// Resolve routes: sandboxed format uses (routeCtx, pluginCtx) two-arg
	// pattern. Native format uses (ctx: RouteContext) single-arg pattern
	// where RouteContext extends PluginContext with
	// { input, request, requestMeta }. We wrap sandboxed route handlers
	// to merge the two args into one.
	//
	// Route entries can be bare functions or `{ handler, public?, input? }`
	// config objects; normalise to the config shape inside the loop.
	const resolvedRoutes: Record<string, PluginRoute> = {};
	if (definition.routes) {
		for (const [routeName, rawEntry] of Object.entries(definition.routes)) {
			const normalized = normalizeRouteEntry(rawEntry);
			const {
				handler,
				public: publicFlag,
				cacheControl,
				input: inputSchema,
				permission,
			} = normalized;
			resolvedRoutes[routeName] = {
				input: inputSchema,
				public: publicFlag,
				permission,
				cacheControl,
				handler: async (ctx) => {
					// `ctx.request` is a real WHATWG `Request` (this is the
					// in-process adapter; the worker-sandbox adapter handles
					// the serialised case). Flatten `Headers` to the plain
					// `Record<string, string>` shape that author-facing
					// `SandboxedRequest` promises so handler bodies are
					// identical across both adapters.
					const headers: Record<string, string> = {};
					ctx.request.headers.forEach((value, name) => {
						headers[name] = value;
					});
					const requestShape = {
						url: ctx.request.url,
						method: ctx.request.method,
						headers,
					};
					const routeCtx = {
						input: ctx.input,
						request: requestShape,
						requestMeta: ctx.requestMeta,
					};
					const { input: _, request: __, requestMeta: ___, ...pluginCtx } = ctx;
					return handler(routeCtx, pluginCtx);
				},
			};
		}
	}

	// Build capabilities from descriptor.
	// Validate against the known set (same as defineNativePlugin). Both
	// current and deprecated names are accepted; deprecated names are
	// silently normalized to current names below so the runtime only ever
	// sees the canonical form.
	const rawCapabilities = descriptor.capabilities ?? [];
	for (const cap of rawCapabilities) {
		if (!VALID_CAPABILITIES_SET.has(cap)) {
			throw new Error(
				`Invalid capability "${cap}" in plugin "${pluginId}". ` +
					`Valid capabilities: ${[...VALID_CAPABILITIES_SET].join(", ")}`,
			);
		}
	}

	// Silent normalization: rewrite deprecated names to current names.
	// Safe assertion — `normalizeCapabilities` only emits validated input
	// plus current names from the rename map, all of which are in the union.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated above; normalizeCapabilities only returns capabilities from the union
	const capabilities = normalizeCapabilities(rawCapabilities) as PluginCapability[];
	const allowedHosts = descriptor.allowedHosts ?? [];

	// Capability implications: broader capabilities imply narrower ones
	// (mirrors the normalization in define-plugin.ts for native format).
	// Operates on canonical names only.
	if (capabilities.includes("content:write") && !capabilities.includes("content:read")) {
		capabilities.push("content:read");
	}
	if (capabilities.includes("media:write") && !capabilities.includes("media:read")) {
		capabilities.push("media:read");
	}
	if (
		capabilities.includes("network:request:unrestricted") &&
		!capabilities.includes("network:request")
	) {
		capabilities.push("network:request");
	}

	// Build storage config from descriptor.
	// StorageCollectionDeclaration uses optional indexes, but PluginStorageConfig
	// requires them. Ensure every collection has an indexes array.
	const rawStorage = descriptor.storage ?? {};
	const storage: PluginStorageConfig = {};
	for (const [name, config] of Object.entries(rawStorage)) {
		storage[name] = {
			indexes: config.indexes ?? [],
			uniqueIndexes: config.uniqueIndexes,
		};
	}

	// Build admin config from descriptor.
	// Portable Text blocks and field widgets are declarative (Block Kit), so they
	// are forwarded for standard/sandboxed plugins just like pages and widgets —
	// the admin editor consumes them from the manifest. Only the site-side render
	// component (`componentsEntry`) stays native-only.
	const admin: PluginAdminConfig = {};
	if (descriptor.adminPages) {
		admin.pages = descriptor.adminPages;
	}
	if (descriptor.adminWidgets) {
		admin.widgets = descriptor.adminWidgets;
	}
	if (descriptor.settingsSchema) {
		admin.settingsSchema = descriptor.settingsSchema;
	}
	if (descriptor.portableTextBlocks) {
		admin.portableTextBlocks = descriptor.portableTextBlocks;
	}
	if (descriptor.fieldWidgets) {
		admin.fieldWidgets = descriptor.fieldWidgets;
	}

	return {
		id: pluginId,
		version,
		capabilities,
		allowedHosts,
		storage,
		hooks: resolvedHooks,
		routes: resolvedRoutes,
		mcp: {
			tools: Object.fromEntries(
				Object.entries(definition.mcp?.tools ?? {}).map(([name, tool]) => [
					name,
					{
						description: tool.description,
						route: tool.route,
						input: tool.input,
						output: tool.output,
						destructive: tool.destructive,
					},
				]),
			),
		},
		admin,
	};
}
