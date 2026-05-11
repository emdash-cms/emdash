/**
 * definePlugin() Helper
 *
 * Creates a properly typed and normalized plugin definition.
 * Supports two formats:
 *
 * 1. **Native format** -- full PluginDefinition with id, version, capabilities, etc.
 *    Returns a ResolvedPlugin.
 *
 * 2. **Standard format** -- just { hooks, routes }. No id/version/capabilities.
 *    Returns the same object (identity function for type inference).
 *    Metadata comes from the descriptor at config time.
 *
 */

import { normalizeCapabilities } from "./types.js";
import type {
	PluginDefinition,
	ResolvedPlugin,
	PluginHooks,
	ResolvedPluginHooks,
	ResolvedHook,
	HookConfig,
	PluginCapability,
	PluginStorageConfig,
	StandardPluginDefinition,
} from "./types.js";

// Plugin ID validation patterns
const SIMPLE_ID = /^[a-z0-9-]+$/;
const SCOPED_ID = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

/**
 * Define an EmDash plugin.
 *
 * **Standard format** -- the canonical format for plugins that work in both
 * trusted and sandboxed modes. No id/version -- those come from the descriptor.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "emdash";
 *
 * export default definePlugin({
 *   hooks: {
 *     "content:afterSave": {
 *       handler: async (event, ctx) => {
 *         await ctx.kv.set("lastSave", Date.now());
 *       },
 *     },
 *   },
 *   routes: {
 *     status: {
 *       handler: async (routeCtx, ctx) => ({ ok: true }),
 *     },
 *   },
 * });
 * ```
 *
 * **Native format** -- for plugins that need React admin, direct DB access,
 * or other capabilities not available in the sandbox.
 *
 * @example
 * ```typescript
 * import { definePlugin } from "emdash";
 *
 * export default definePlugin({
 *   id: "my-plugin",
 *   version: "1.0.0",
 *   capabilities: ["content:read"],
 *   hooks: {
 *     "content:beforeSave": async (event, ctx) => {
 *       ctx.log.info("Saving content", { collection: event.collection });
 *       return event.content;
 *     }
 *   },
 *   routes: {
 *     "sync": {
 *       handler: async (ctx) => {
 *         return { status: "ok" };
 *       }
 *     }
 *   }
 * });
 * ```
 */
// Native overload first -- PluginDefinition (with id+version) is more specific
export function definePlugin<TStorage extends PluginStorageConfig>(
	definition: PluginDefinition<TStorage>,
): ResolvedPlugin<TStorage>;
// Standard overload second -- catches { hooks, routes } without id/version
export function definePlugin(definition: StandardPluginDefinition): StandardPluginDefinition;
export function definePlugin<TStorage extends PluginStorageConfig>(
	definition: PluginDefinition<TStorage> | StandardPluginDefinition,
): ResolvedPlugin<TStorage> | StandardPluginDefinition {
	// Standard format: has hooks/routes but no id/version
	if (!("id" in definition) || !("version" in definition)) {
		// Validate that the standard format has at least hooks or routes
		if (!("hooks" in definition) && !("routes" in definition)) {
			throw new Error(
				"Standard plugin format requires at least `hooks` or `routes`. " +
					"For native format, provide `id` and `version`.",
			);
		}
		// Identity function -- return as-is for type inference.
		// The adapter (adaptSandboxEntry) will convert this to a ResolvedPlugin at build time.
		return definition;
	}

	return defineNativePlugin(definition);
}

/**
 * Internal: define a native-format plugin with full validation and normalization.
 */
function defineNativePlugin<TStorage extends PluginStorageConfig>(
	definition: PluginDefinition<TStorage>,
): ResolvedPlugin<TStorage> {
	const {
		id,
		version,
		capabilities = [],
		allowedHosts = [],
		hooks = {},
		routes = {},
		admin = {},
	} = definition;

	// Default to empty object if no storage declared.
	// The empty object satisfies PluginStorageConfig (Record<string, ...>).
	// The cast is structurally safe because an empty record has no keys to conflict.
	const storage = (definition.storage ?? {}) as TStorage;

	// Validate id format: either simple (my-plugin) or scoped (@scope/my-plugin)
	// Simple: lowercase alphanumeric with dashes
	// Scoped: @scope/name where both parts are lowercase alphanumeric with dashes
	if (!SIMPLE_ID.test(id) && !SCOPED_ID.test(id)) {
		throw new Error(
			`Invalid plugin id "${id}". Must be lowercase alphanumeric with dashes (e.g., "my-plugin" or "@scope/my-plugin").`,
		);
	}

	// Validate version format (basic semver)
	if (!SEMVER_PATTERN.test(version)) {
		throw new Error(`Invalid plugin version "${version}". Must be semver format (e.g., "1.0.0").`);
	}

	// Validate capabilities. Both current names and deprecated aliases are
	// accepted; aliases are silently rewritten to current names below so the
	// runtime only ever sees the canonical form. Authors are warned at
	// bundle/validate and hard-failed at publish.
	const validCapabilities = new Set<string>([
		// Current names
		"network:request",
		"network:request:unrestricted",
		"content:read",
		"content:write",
		"media:read",
		"media:write",
		"users:read",
		"email:send",
		"hooks.email-transport:register",
		"hooks.email-events:register",
		"hooks.page-fragments:register",
		// Deprecated aliases
		"network:fetch",
		"network:fetch:any",
		"read:content",
		"write:content",
		"read:media",
		"write:media",
		"read:users",
		"email:provide",
		"email:intercept",
		"page:inject",
	]);
	for (const cap of capabilities) {
		if (!validCapabilities.has(cap)) {
			throw new Error(`Invalid capability "${cap}" in plugin "${id}".`);
		}
	}

	// Silent normalization: rewrite deprecated names to current names. Done
	// before the implication pass so implications work on canonical names.
	// `as PluginCapability[]` is safe because `normalizeCapabilities` only
	// returns strings from the validated input plus current names from the
	// rename map, all of which are in the union.
	const canonical = normalizeCapabilities(capabilities) as PluginCapability[];

	// Capability implications: broader capabilities imply narrower ones.
	// Operates on canonical names only.
	const normalizedCapabilities: PluginCapability[] = [...canonical];
	if (canonical.includes("content:write") && !canonical.includes("content:read")) {
		normalizedCapabilities.push("content:read");
	}
	if (canonical.includes("media:write") && !canonical.includes("media:read")) {
		normalizedCapabilities.push("media:read");
	}
	if (
		canonical.includes("network:request:unrestricted") &&
		!canonical.includes("network:request")
	) {
		normalizedCapabilities.push("network:request");
	}

	// Normalize hooks
	const resolvedHooks = resolveHooks(hooks, id);

	return {
		id,
		version,
		capabilities: normalizedCapabilities,
		allowedHosts,
		storage,
		hooks: resolvedHooks,
		routes,
		admin,
	};
}

/**
 * Resolve hooks to normalized format with defaults.
 *
 * PluginHooks and ResolvedPluginHooks share the same keys — each input value is
 * `HookConfig<H> | H` and the output is `ResolvedHook<H>`.  TS can't narrow
 * the handler type through a dynamic key, so we assert at the loop boundary.
 */
function resolveHooks(hooks: PluginHooks, pluginId: string): ResolvedPluginHooks {
	const resolved: ResolvedPluginHooks = {};

	for (const key of Object.keys(hooks) as Array<keyof PluginHooks>) {
		const hook = hooks[key];
		if (hook) {
			(resolved as Record<string, unknown>)[key] = resolveHook(hook, pluginId);
		}
	}

	return resolved;
}

/**
 * Check if a hook value is a config object (has a `handler` property)
 */
function isHookConfig<THandler>(
	hook: HookConfig<THandler> | THandler,
): hook is HookConfig<THandler> {
	return typeof hook === "object" && hook !== null && "handler" in hook;
}

/**
 * Resolve a single hook to normalized format
 */
function resolveHook<THandler>(
	hook: HookConfig<THandler> | THandler,
	pluginId: string,
): ResolvedHook<THandler> {
	// If it's a config object with handler property
	if (isHookConfig(hook)) {
		if (hook.exclusive !== undefined && typeof hook.exclusive !== "boolean") {
			throw new Error(
				`Invalid "exclusive" value in hook config for plugin "${pluginId}". Must be boolean.`,
			);
		}
		return {
			priority: hook.priority ?? 100,
			timeout: hook.timeout ?? 5000,
			dependencies: hook.dependencies ?? [],
			errorPolicy: hook.errorPolicy ?? "abort",
			exclusive: hook.exclusive ?? false,
			handler: hook.handler,
			pluginId,
		};
	}

	// It's just a handler function
	return {
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "abort",
		exclusive: false,
		handler: hook,
		pluginId,
	};
}

export default definePlugin;
