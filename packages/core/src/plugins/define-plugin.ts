/**
 * definePlugin() Helper
 *
 * Native plugin authoring entry. Returns a fully-resolved
 * `ResolvedPlugin` ready for the host integration to mount.
 *
 * Sandboxed plugins do NOT use this function. They default-export
 * a bare `{ hooks?, routes? }` object with a `satisfies SandboxedPlugin`
 * annotation from `emdash/plugin`. See the `emdash` changeset for the
 * authoring shape.
 */

import {
	isJsonPostRouteContract,
	PLUGIN_CAPABILITIES,
	type PluginRouteBodyMode,
} from "@emdash-cms/plugin-types";

import { normalizePluginCapabilities } from "./types.js";
import type {
	PluginDefinition,
	ResolvedPlugin,
	PluginHooks,
	ResolvedPluginHooks,
	ResolvedHook,
	HookConfig,
	PluginRouteDefinition,
	PluginStorageConfig,
} from "./types.js";

const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Define a native EmDash plugin.
 *
 * Native plugins ship as regular npm modules, get installed via
 * `pnpm add` + an `astro.config.mjs` edit, and run in the host
 * process. They have full access to the runtime — capabilities are
 * still enforced by `PluginContextFactory`, but there is no isolation
 * boundary.
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
 *
 * Sandboxed-format plugins do not use `definePlugin`. They
 * default-export a bare `{ hooks?, routes? }` object with a
 * `satisfies SandboxedPlugin` annotation from `emdash/plugin`. Calling
 * `definePlugin` with an object that has no `id` throws at runtime
 * (the type system already rejects it at compile time — this check is
 * for callers that bypass typechecking).
 */
export function definePlugin<TStorage extends PluginStorageConfig>(
	definition: PluginDefinition<TStorage>,
): ResolvedPlugin<TStorage> {
	// Semantic check, not a structural one: `id` is what makes this a
	// native definition. Sandboxed plugins (the only other shape that
	// might land here at runtime) intentionally never have an `id` —
	// identity comes from the manifest's `slug` + `publisher`, computed
	// at install time. So "no id" is the unambiguous signal that the
	// caller meant the sandboxed authoring flow.
	if (typeof definition.id !== "string" || definition.id.length === 0) {
		throw new Error(
			`definePlugin() requires \`id\` (got ${typeof definition.id}). ` +
				"For native plugins, make sure your definition has both `id` and " +
				"`version`. For sandboxed plugins, drop `definePlugin()` entirely " +
				"and `export default { hooks, routes } satisfies SandboxedPlugin` " +
				'from "emdash/plugin" — identity comes from `emdash-plugin.jsonc`.',
		);
	}
	return defineNativePlugin(definition);
}

export function definePluginRoute<TMode extends PluginRouteBodyMode>(
	route: PluginRouteDefinition<TMode>,
): PluginRouteDefinition<TMode> {
	return route;
}

/**
 * Internal: define a native-format plugin with full validation and normalization.
 */
function defineNativePlugin<TStorage extends PluginStorageConfig>(
	definition: PluginDefinition<TStorage>,
): ResolvedPlugin<TStorage> {
	// Declared function-local (not module scope) on purpose. Under
	// `ssr.noExternal` the worker entry can instantiate native plugins during a
	// circular module init, reaching this function before module-scope consts
	// initialize -> "Cannot access 'SIMPLE_ID' before initialization" -> every
	// route 500s on Cloudflare Workers. Call-time consts evaluate after the
	// literals are parsed, so the temporal dead zone cannot occur regardless of
	// bundle ordering.
	// oxlint-disable-next-line e18e/prefer-static-regex -- avoids circular-init TDZ
	const SIMPLE_ID = /^[a-z0-9-]+$/;
	// oxlint-disable-next-line e18e/prefer-static-regex -- avoids circular-init TDZ
	const SCOPED_ID = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
	// oxlint-disable-next-line e18e/prefer-static-regex -- avoids circular-init TDZ
	const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

	const {
		id,
		version,
		capabilities = [],
		allowedHosts = [],
		hooks = {},
		routes = {},
		mcp = { tools: {} },
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

	for (const [name, tool] of Object.entries(mcp.tools)) {
		if (!MCP_TOOL_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid MCP tool name "${name}" in plugin "${id}".`);
		}
		const route = routes[tool.route];
		if (!route) throw new Error(`MCP tool "${name}" references unknown route "${tool.route}".`);
		if (route.public) throw new Error(`MCP tool "${name}" cannot reference a public route.`);
		if (route.response === "raw") {
			throw new Error(`MCP tool "${name}" cannot reference a raw response route.`);
		}
		if (!isJsonPostRouteContract(route)) {
			throw new Error(`MCP tool "${name}" must reference a POST-compatible JSON route.`);
		}
		if (!route.permission) {
			throw new Error(`MCP route "${tool.route}" must declare a permission.`);
		}
	}

	for (const [kind, extensions] of [
		["editor panel", admin.editorPanels],
		["editor action", admin.editorActions],
	] as const) {
		for (const extension of extensions ?? []) {
			const route = routes[extension.route];
			if (!route) {
				throw new Error(
					`Plugin ${kind} "${extension.id}" references unknown route "${extension.route}".`,
				);
			}
			if (route.public) {
				throw new Error(`Plugin ${kind} "${extension.id}" must reference a private route.`);
			}
			if (!isJsonPostRouteContract(route)) {
				throw new Error(
					`Plugin ${kind} "${extension.id}" must reference a route that accepts POST JSON requests and returns JSON.`,
				);
			}
		}
	}

	if ((admin.pages?.length ?? 0) > 0 || (admin.widgets?.length ?? 0) > 0) {
		const adminRoute = routes.admin;
		if (adminRoute && (adminRoute.public === true || !isJsonPostRouteContract(adminRoute))) {
			throw new Error("Block Kit admin route must accept POST JSON requests and return JSON.");
		}
	}

	// Validate capabilities. Both current names and deprecated aliases are
	// accepted; aliases are silently rewritten to current names below so the
	// runtime only ever sees the canonical form. Authors are warned at
	// bundle/validate and hard-failed at publish.
	const validCapabilities = new Set<string>(PLUGIN_CAPABILITIES);
	for (const cap of capabilities) {
		if (!validCapabilities.has(cap)) {
			throw new Error(`Invalid capability "${cap}" in plugin "${id}".`);
		}
	}

	const normalizedCapabilities = normalizePluginCapabilities(capabilities);

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
		mcp,
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
