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
import { PLUGIN_CAPABILITIES, HOOK_NAMES } from "./manifest-schema.js";
import { normalizeCapabilities } from "./types.js";
import type {
	StandardPluginDefinition,
	StandardHookEntry,
	StandardHookHandler,
	ResolvedPlugin,
	ResolvedPluginHooks,
	ResolvedHook,
	PluginRoute,
	PluginCapability,
	PluginStorageConfig,
	PluginAdminConfig,
} from "./types.js";

/**
 * Default hook configuration values
 */
const DEFAULT_PRIORITY = 100;
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_ERROR_POLICY = "abort" as const;

/**
 * Check if a standard hook entry is a config object (has a `handler` property)
 */
function isHookConfig(
	entry: StandardHookEntry,
): entry is Exclude<StandardHookEntry, StandardHookHandler> {
	return typeof entry === "object" && entry !== null && "handler" in entry;
}

/**
 * Resolve a single standard hook entry to a ResolvedHook.
 *
 * Standard-format hooks use the sandbox entry convention:
 *   handler(event, ctx) -- two args
 *
 * The HookPipeline dispatch methods also call handlers with (event, ctx),
 * so the handler is compatible as-is. We just need to wrap it for type safety.
 */
function resolveStandardHook(
	entry: StandardHookEntry,
	pluginId: string,
): ResolvedHook<StandardHookHandler> {
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

const VALID_CAPABILITIES_SET = new Set<string>(PLUGIN_CAPABILITIES);

const VALID_HOOK_NAMES_SET = new Set<string>(HOOK_NAMES);

/**
 * Adapt a standard-format plugin definition into a ResolvedPlugin.
 *
 * This is the core of the unified plugin format. It takes the `{ hooks, routes }`
 * export from a standard plugin and produces a ResolvedPlugin that can enter the
 * HookPipeline alongside native plugins.
 *
 * @param definition - The standard plugin definition (from definePlugin() or raw export)
 * @param descriptor - The plugin descriptor with id, version, capabilities, etc.
 * @returns A ResolvedPlugin compatible with HookPipeline
 */
export function adaptSandboxEntry(
	definition: StandardPluginDefinition,
	descriptor: PluginDescriptor,
): ResolvedPlugin {
	const pluginId = descriptor.id;
	const version = descriptor.version;

	// Resolve hooks
	const resolvedHooks: ResolvedPluginHooks = {};
	if (definition.hooks) {
		for (const [hookName, entry] of Object.entries(definition.hooks)) {
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
			(resolvedHooks as Record<string, unknown>)[hookName] = resolveStandardHook(entry, pluginId);
		}
	}

	// Resolve routes: standard format uses (routeCtx, pluginCtx) two-arg pattern.
	// Native format uses (ctx: RouteContext) single-arg pattern where RouteContext
	// extends PluginContext with { input, request, requestMeta }.
	// We wrap standard route handlers to merge the two args into one.
	const resolvedRoutes: Record<string, PluginRoute> = {};
	if (definition.routes) {
		for (const [routeName, routeEntry] of Object.entries(definition.routes)) {
			const standardHandler = routeEntry.handler;
			resolvedRoutes[routeName] = {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- StandardRouteEntry.input is intentionally loosely typed; callers validate at runtime
				input: routeEntry.input as PluginRoute["input"],
				public: routeEntry.public,
				handler: async (ctx) => {
					// Build the routeCtx shape that standard handlers expect
					const routeCtx = {
						input: ctx.input,
						request: ctx.request,
						requestMeta: ctx.requestMeta,
					};
					// Pass only the PluginContext portion (without input/request/requestMeta)
					// to match what sandboxed handlers receive.
					const { input: _, request: __, requestMeta: ___, ...pluginCtx } = ctx;
					return standardHandler(routeCtx, pluginCtx);
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

	// Build admin config from descriptor
	const admin: PluginAdminConfig = {};
	if (descriptor.adminPages) {
		admin.pages = descriptor.adminPages;
	}
	if (descriptor.adminWidgets) {
		admin.widgets = descriptor.adminWidgets;
	}

	return {
		id: pluginId,
		version,
		capabilities,
		allowedHosts,
		storage,
		hooks: resolvedHooks,
		routes: resolvedRoutes,
		admin,
	};
}
