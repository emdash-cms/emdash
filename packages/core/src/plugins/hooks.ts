/**
 * Plugin Hooks System v2
 *
 * Uses the unified PluginContext for all hooks.
 * Manages lifecycle hooks with:
 * - Deterministic ordering via priority + dependencies
 * - Timeout enforcement
 * - Error isolation
 * - Observability
 *
 */

import { PluginContextFactory, type PluginContextFactoryOptions } from "./context.js";
import type {
	ResolvedPlugin,
	ResolvedHook,
	PluginContext,
	ContentHookEvent,
	ContentDeleteEvent,
	ContentPublishStateChangeEvent,
	MediaUploadEvent,
	MediaAfterUploadEvent,
	LifecycleEvent,
	UninstallEvent,
	CronEvent,
	EmailBeforeSendEvent,
	EmailBeforeSendHandler,
	EmailDeliverHandler,
	EmailAfterSendHandler,
	ContentBeforeSaveHandler,
	ContentAfterSaveHandler,
	ContentBeforeDeleteHandler,
	ContentAfterDeleteHandler,
	ContentAfterPublishHandler,
	ContentAfterUnpublishHandler,
	MediaBeforeUploadHandler,
	MediaAfterUploadHandler,
	LifecycleHandler,
	UninstallHandler,
	CronHandler,
	EmailMessage,
	CommentBeforeCreateEvent,
	CommentBeforeCreateHandler,
	CommentModerateHandler,
	CommentAfterCreateEvent,
	CommentAfterCreateHandler,
	CommentAfterModerateEvent,
	CommentAfterModerateHandler,
	PageMetadataEvent,
	PageMetadataHandler,
	PageMetadataContribution,
	PageFragmentEvent,
	PageFragmentHandler,
	PageFragmentContribution,
} from "./types.js";

// Hook name type for v2
type HookNameV2 =
	| "plugin:install"
	| "plugin:activate"
	| "plugin:deactivate"
	| "plugin:uninstall"
	| "content:beforeSave"
	| "content:afterSave"
	| "content:beforeDelete"
	| "content:afterDelete"
	| "content:afterPublish"
	| "content:afterUnpublish"
	| "media:beforeUpload"
	| "media:afterUpload"
	| "cron"
	| "email:beforeSend"
	| "email:deliver"
	| "email:afterSend"
	| "comment:beforeCreate"
	| "comment:moderate"
	| "comment:afterCreate"
	| "comment:afterModerate"
	| "page:metadata"
	| "page:fragments";

/**
 * Map from hook name to handler type — used for type-safe hook retrieval
 */
interface HookHandlerMap {
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
 * Hook execution result
 */
export interface HookResult<T> {
	success: boolean;
	value?: T;
	error?: Error;
	pluginId: string;
	duration: number;
}

/**
 * Hook pipeline for executing hooks in order
 */
export class HookPipeline {
	private hooks: Map<HookNameV2, Array<ResolvedHook<unknown>>> = new Map();
	private pluginMap: Map<string, ResolvedPlugin> = new Map();
	private contextFactory: PluginContextFactory | null = null;
	/** Stored so setContextFactory can merge incrementally. */
	private contextFactoryOptions: Partial<PluginContextFactoryOptions> = {};

	/** Hook names where at least one handler declared exclusive: true */
	private exclusiveHookNames: Set<string> = new Set();

	/**
	 * Selected provider plugin ID for each exclusive hook.
	 * Set by the PluginManager after resolution.
	 */
	private exclusiveSelections: Map<string, string> = new Map();

	constructor(plugins: ResolvedPlugin[], factoryOptions?: PluginContextFactoryOptions) {
		if (factoryOptions) {
			this.contextFactory = new PluginContextFactory(factoryOptions);
			this.contextFactoryOptions = { ...factoryOptions };
		}

		for (const plugin of plugins) {
			this.pluginMap.set(plugin.id, plugin);
		}
		this.registerPlugins(plugins);
	}

	/**
	 * Set or update the context factory options.
	 *
	 * When called on a pipeline that already has a factory, the new options
	 * are merged on top of the existing ones so that callers don't need to
	 * repeat every field (e.g. adding `cronReschedule` without losing
	 * `storage` / `getUploadUrl`).
	 */
	setContextFactory(options: Partial<PluginContextFactoryOptions>): void {
		const merged = { ...this.contextFactoryOptions, ...options };
		// The first call must include `db`; subsequent calls merge incrementally.
		this.contextFactory = new PluginContextFactory(merged as PluginContextFactoryOptions);
		this.contextFactoryOptions = merged;
	}

	/**
	 * Get context for a plugin
	 */
	private getContext(pluginId: string): PluginContext {
		const plugin = this.pluginMap.get(pluginId);
		if (!plugin) {
			throw new Error(`Plugin "${pluginId}" not found`);
		}
		if (!this.contextFactory) {
			throw new Error("Context factory not initialized - call setContextFactory first");
		}
		return this.contextFactory.createContext(plugin);
	}

	/**
	 * Get typed hooks for a specific hook name.
	 * The internal map stores ResolvedHook<unknown>, but we know each name
	 * maps to a specific handler type via HookHandlerMap.
	 *
	 * Exclusive hooks that have a selected provider are filtered out — they
	 * should only run via invokeExclusiveHook(), not in the regular pipeline.
	 */
	private getTypedHooks<N extends HookNameV2>(name: N): Array<ResolvedHook<HookHandlerMap[N]>> {
		// The map stores hooks as ResolvedHook<unknown>. Each hook name corresponds
		// to a specific handler type. The cast here is the single point where we
		// bridge the untyped map to the typed API — callers never need to cast.
		const all = (this.hooks.get(name) ?? []) as Array<ResolvedHook<HookHandlerMap[N]>>;

		// If this hook has an exclusive selection, filter out all exclusive handlers
		// so they don't run in the regular pipeline
		if (this.exclusiveSelections.has(name)) {
			return all.filter((h) => !h.exclusive);
		}

		return all;
	}

	/**
	 * Register all hooks from plugins.
	 *
	 * Registers each hook name individually to preserve type safety. The
	 * internal map stores ResolvedHook<unknown> since it's keyed by string,
	 * but getTypedHooks() restores the correct handler type on retrieval.
	 */
	private registerPlugins(plugins: ResolvedPlugin[]): void {
		for (const plugin of plugins) {
			this.registerPluginHook(plugin, "plugin:install");
			this.registerPluginHook(plugin, "plugin:activate");
			this.registerPluginHook(plugin, "plugin:deactivate");
			this.registerPluginHook(plugin, "plugin:uninstall");
			this.registerPluginHook(plugin, "content:beforeSave");
			this.registerPluginHook(plugin, "content:afterSave");
			this.registerPluginHook(plugin, "content:beforeDelete");
			this.registerPluginHook(plugin, "content:afterDelete");
			this.registerPluginHook(plugin, "content:afterPublish");
			this.registerPluginHook(plugin, "content:afterUnpublish");
			this.registerPluginHook(plugin, "media:beforeUpload");
			this.registerPluginHook(plugin, "media:afterUpload");
			this.registerPluginHook(plugin, "cron");
			this.registerPluginHook(plugin, "email:beforeSend");
			this.registerPluginHook(plugin, "email:deliver");
			this.registerPluginHook(plugin, "email:afterSend");
			this.registerPluginHook(plugin, "comment:beforeCreate");
			this.registerPluginHook(plugin, "comment:moderate");
			this.registerPluginHook(plugin, "comment:afterCreate");
			this.registerPluginHook(plugin, "comment:afterModerate");
			this.registerPluginHook(plugin, "page:metadata");
			this.registerPluginHook(plugin, "page:fragments");
		}

		// Sort hooks by priority and dependencies
		for (const [hookName, hooks] of this.hooks) {
			this.hooks.set(hookName, this.sortHooks(hooks));
		}
	}

	/**
	 * Maps hook names to the capability required to register them.
	 *
	 * Hooks not listed here have no capability requirement (e.g. lifecycle
	 * hooks, cron). Any plugin declaring a listed hook without the required
	 * capability will have that hook silently skipped at registration time.
	 */
	private static readonly HOOK_REQUIRED_CAPABILITY: ReadonlyMap<string, string> = new Map([
		// Email
		["email:beforeSend", "email:intercept"],
		["email:afterSend", "email:intercept"],
		["email:deliver", "email:provide"],
		// Content — beforeSave can mutate content, so requires write:content.
		// afterSave is read-only notification, so read:content suffices.
		["content:beforeSave", "write:content"],
		["content:afterSave", "read:content"],
		["content:beforeDelete", "read:content"],
		["content:afterDelete", "read:content"],
		["content:afterPublish", "read:content"],
		["content:afterUnpublish", "read:content"],
		// Media
		["media:beforeUpload", "write:media"],
		["media:afterUpload", "read:media"],
		// Comments — hooks expose author email, IP hash, user agent
		["comment:beforeCreate", "read:users"],
		["comment:moderate", "read:users"],
		["comment:afterCreate", "read:users"],
		["comment:afterModerate", "read:users"],
		// Page fragments — can inject arbitrary scripts into every public page
		["page:fragments", "page:inject"],
	]);

	/**
	 * Register a single plugin's hook by name
	 */
	private registerPluginHook(plugin: ResolvedPlugin, name: HookNameV2): void {
		const hook = plugin.hooks[name];
		if (!hook) return;

		// Hooks that expose sensitive data or inject into pages require specific
		// capabilities. Plugins without the required capability have the hook
		// silently skipped to prevent unauthorized data access or page injection.
		const requiredCapability = HookPipeline.HOOK_REQUIRED_CAPABILITY.get(name);
		if (requiredCapability && !plugin.capabilities.includes(requiredCapability as never)) {
			console.warn(
				`[hooks] Plugin "${plugin.id}" declares ${name} hook without ${requiredCapability} capability — skipping`,
			);
			return;
		}

		// Track exclusive hooks
		if (hook.exclusive) {
			this.exclusiveHookNames.add(name);
		}

		// ResolvedHook<SpecificHandler> is assignable to ResolvedHook<unknown>
		// because the handler property is covariant
		this.registerHook(name, hook);
	}

	/**
	 * Register a single hook
	 */
	private registerHook(name: HookNameV2, hook: ResolvedHook<unknown>): void {
		const existing = this.hooks.get(name) || [];
		existing.push(hook);
		this.hooks.set(name, existing);
	}

	/**
	 * Sort hooks by priority and dependencies
	 */
	private sortHooks(hooks: Array<ResolvedHook<unknown>>): Array<ResolvedHook<unknown>> {
		const sorted: Array<ResolvedHook<unknown>> = [];
		const remaining = [...hooks];

		// Simple topological sort with priority as tiebreaker
		while (remaining.length > 0) {
			// Find hooks whose dependencies are satisfied
			const ready = remaining.filter((hook) =>
				hook.dependencies.every((dep) => sorted.some((s) => s.pluginId === dep)),
			);

			if (ready.length === 0) {
				// Circular dependency or missing dependency - log warning and fall back to priority
				const pluginIds = remaining.map((h) => h.pluginId).join(", ");
				console.warn(
					`[hooks] Hook dependency cycle or missing dependency detected among plugins: ${pluginIds}. Falling back to priority order.`,
				);
				remaining.sort((a, b) => a.priority - b.priority);
				sorted.push(...remaining);
				break;
			}

			// Sort ready hooks by priority and add the first one
			ready.sort((a, b) => a.priority - b.priority);
			const next = ready[0];
			sorted.push(next);
			remaining.splice(remaining.indexOf(next), 1);
		}

		return sorted;
	}

	/**
	 * Execute a hook with timeout
	 */
	private async executeWithTimeout<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<T>(
			(_, reject) =>
				(timer = setTimeout(() => reject(new Error(`Hook timeout after ${timeout}ms`)), timeout)),
		);
		try {
			return await Promise.race([fn(), timeoutPromise]);
		} finally {
			clearTimeout(timer!);
		}
	}

	// =========================================================================
	// Lifecycle Hooks
	// =========================================================================

	/**
	 * Run plugin:install hooks
	 */
	async runPluginInstall(pluginId: string): Promise<HookResult<void>[]> {
		return this.runLifecycleHook("plugin:install", pluginId);
	}

	/**
	 * Run plugin:activate hooks
	 */
	async runPluginActivate(pluginId: string): Promise<HookResult<void>[]> {
		return this.runLifecycleHook("plugin:activate", pluginId);
	}

	/**
	 * Run plugin:deactivate hooks
	 */
	async runPluginDeactivate(pluginId: string): Promise<HookResult<void>[]> {
		return this.runLifecycleHook("plugin:deactivate", pluginId);
	}

	/**
	 * Run plugin:uninstall hooks
	 */
	async runPluginUninstall(pluginId: string, deleteData: boolean): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("plugin:uninstall");
		const results: HookResult<void>[] = [];

		// Only run the hook for the specific plugin being uninstalled
		const hook = hooks.find((h) => h.pluginId === pluginId);
		if (!hook) return results;

		const { handler } = hook;
		const event: UninstallEvent = { deleteData };
		const ctx = this.getContext(pluginId);
		const start = Date.now();

		try {
			await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			results.push({
				success: true,
				pluginId: hook.pluginId,
				duration: Date.now() - start,
			});
		} catch (error) {
			results.push({
				success: false,
				error: error instanceof Error ? error : new Error(String(error)),
				pluginId: hook.pluginId,
				duration: Date.now() - start,
			});
		}

		return results;
	}

	private async runLifecycleHook(
		hookName: "plugin:install" | "plugin:activate" | "plugin:deactivate",
		pluginId: string,
	): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks(hookName);
		const results: HookResult<void>[] = [];

		// Only run the hook for the specific plugin
		const hook = hooks.find((h) => h.pluginId === pluginId);
		if (!hook) return results;

		const { handler } = hook;
		const event: LifecycleEvent = {};
		const ctx = this.getContext(pluginId);
		const start = Date.now();

		try {
			await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			results.push({
				success: true,
				pluginId: hook.pluginId,
				duration: Date.now() - start,
			});
		} catch (error) {
			results.push({
				success: false,
				error: error instanceof Error ? error : new Error(String(error)),
				pluginId: hook.pluginId,
				duration: Date.now() - start,
			});
		}

		return results;
	}

	// =========================================================================
	// Content Hooks
	// =========================================================================

	/**
	 * Run content:beforeSave hooks
	 * Returns modified content from the pipeline
	 */
	async runContentBeforeSave(
		content: Record<string, unknown>,
		collection: string,
		isNew: boolean,
	): Promise<{
		content: Record<string, unknown>;
		results: HookResult<Record<string, unknown>>[];
	}> {
		const hooks = this.getTypedHooks("content:beforeSave");
		const results: HookResult<Record<string, unknown>>[] = [];
		let currentContent = content;

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentHookEvent = {
				content: currentContent,
				collection,
				isNew,
			};
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				const result = await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				// Handler can return modified content or void (keep current)
				if (result !== undefined) {
					currentContent = result;
				}
				results.push({
					success: true,
					value: currentContent,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return { content: currentContent, results };
	}

	/**
	 * Run content:afterSave hooks
	 */
	async runContentAfterSave(
		content: Record<string, unknown>,
		collection: string,
		isNew: boolean,
	): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("content:afterSave");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentHookEvent = { content, collection, isNew };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return results;
	}

	/**
	 * Run content:beforeDelete hooks
	 * Returns whether deletion is allowed
	 */
	async runContentBeforeDelete(
		id: string,
		collection: string,
	): Promise<{ allowed: boolean; results: HookResult<boolean>[] }> {
		const hooks = this.getTypedHooks("content:beforeDelete");
		const results: HookResult<boolean>[] = [];
		let allowed = true;

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentDeleteEvent = { id, collection, permanent: false };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				const result = await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				// Handler returns false to block, true or void to allow
				if (result === false) {
					allowed = false;
				}
				results.push({
					success: true,
					value: result !== false,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return { allowed, results };
	}

	/**
	 * Run content:afterDelete hooks
	 */
	async runContentAfterDelete(
		id: string,
		collection: string,
		permanent: boolean,
	): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("content:afterDelete");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentDeleteEvent = { id, collection, permanent };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return results;
	}

	/**
	 * Run content:afterPublish hooks (fire-and-forget).
	 */
	async runContentAfterPublish(
		content: Record<string, unknown>,
		collection: string,
	): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("content:afterPublish");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentPublishStateChangeEvent = { content, collection };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return results;
	}

	/**
	 * Run content:afterUnpublish hooks (fire-and-forget).
	 */
	async runContentAfterUnpublish(
		content: Record<string, unknown>,
		collection: string,
	): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("content:afterUnpublish");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event: ContentPublishStateChangeEvent = { content, collection };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return results;
	}

	// =========================================================================
	// Media Hooks
	// =========================================================================

	/**
	 * Run media:beforeUpload hooks
	 */
	async runMediaBeforeUpload(file: { name: string; type: string; size: number }): Promise<{
		file: { name: string; type: string; size: number };
		results: HookResult<{ name: string; type: string; size: number }>[];
	}> {
		const hooks = this.getTypedHooks("media:beforeUpload");
		const results: HookResult<{
			name: string;
			type: string;
			size: number;
		}>[] = [];
		let currentFile = file;

		for (const hook of hooks) {
			const { handler } = hook;
			const event: MediaUploadEvent = { file: currentFile };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				const result = await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				// Handler can return modified file info or void
				if (result !== undefined) {
					currentFile = result;
				}
				results.push({
					success: true,
					value: currentFile,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return { file: currentFile, results };
	}

	/**
	 * Run media:afterUpload hooks
	 */
	async runMediaAfterUpload(media: {
		id: string;
		filename: string;
		mimeType: string;
		size: number | null;
		url: string;
		createdAt: string;
	}): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("media:afterUpload");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event: MediaAfterUploadEvent = { media };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return results;
	}

	// =========================================================================
	// Cron Hook (per-plugin dispatch)
	// =========================================================================

	/**
	 * Invoke the cron hook for a specific plugin.
	 *
	 * Unlike other hooks which broadcast to all plugins, the cron hook is
	 * dispatched only to the target plugin — the one that owns the task.
	 */
	async invokeCronHook(pluginId: string, event: CronEvent): Promise<HookResult<void>> {
		const hooks = this.getTypedHooks("cron");
		const hook = hooks.find((h) => h.pluginId === pluginId);

		if (!hook) {
			return {
				success: false,
				error: new Error(`Plugin "${pluginId}" has no cron hook registered`),
				pluginId,
				duration: 0,
			};
		}

		const { handler } = hook;
		const ctx = this.getContext(pluginId);
		const start = Date.now();

		try {
			await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			return {
				success: true,
				pluginId,
				duration: Date.now() - start,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error : new Error(String(error)),
				pluginId,
				duration: Date.now() - start,
			};
		}
	}

	// =========================================================================
	// Email Hooks
	// =========================================================================

	/**
	 * Run email:beforeSend hooks (middleware pipeline).
	 *
	 * Each handler receives the message and returns a modified message or
	 * `false` to cancel delivery. The pipeline chains message transformations —
	 * each handler receives the output of the previous one.
	 */
	async runEmailBeforeSend(
		message: EmailMessage,
		source: string,
	): Promise<{ message: EmailMessage | false; results: HookResult<EmailMessage | false>[] }> {
		const hooks = this.getTypedHooks("email:beforeSend");
		const results: HookResult<EmailMessage | false>[] = [];
		let currentMessage: EmailMessage = message;

		for (const hook of hooks) {
			const { handler } = hook;
			// Shallow-clone message to prevent handlers from mutating
			// the shared reference and leaking changes to subsequent stages
			const event: EmailBeforeSendEvent = { message: { ...currentMessage }, source };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				const result = await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);

				if (result === false) {
					// Cancelled
					results.push({
						success: true,
						value: false,
						pluginId: hook.pluginId,
						duration: Date.now() - start,
					});
					return { message: false, results };
				}

				// Handler returned a modified message
				if (result && typeof result === "object") {
					currentMessage = result;
				}

				results.push({
					success: true,
					value: currentMessage,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return { message: currentMessage, results };
	}

	/**
	 * Run email:afterSend hooks (fire-and-forget).
	 *
	 * Errors are logged but don't propagate — they don't affect the caller.
	 */
	async runEmailAfterSend(message: EmailMessage, source: string): Promise<HookResult<void>[]> {
		const hooks = this.getTypedHooks("email:afterSend");
		const results: HookResult<void>[] = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const event = { message, source };
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
				results.push({
					success: true,
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			} catch (error) {
				// Fire-and-forget: log but don't propagate
				console.error(
					`[email:afterSend] Plugin "${hook.pluginId}" error:`,
					error instanceof Error ? error.message : error,
				);
				results.push({
					success: false,
					error: error instanceof Error ? error : new Error(String(error)),
					pluginId: hook.pluginId,
					duration: Date.now() - start,
				});
			}
		}

		return results;
	}

	// =========================================================================
	// Comment Hooks
	// =========================================================================

	/**
	 * Run comment:beforeCreate hooks (middleware pipeline).
	 *
	 * Each handler receives the event and returns a modified event or
	 * `false` to reject the comment. The pipeline chains transformations —
	 * each handler receives the output of the previous one.
	 */
	async runCommentBeforeCreate(
		event: CommentBeforeCreateEvent,
	): Promise<CommentBeforeCreateEvent | false> {
		const hooks = this.getTypedHooks("comment:beforeCreate");
		let currentEvent = event;

		for (const hook of hooks) {
			const { handler } = hook;
			const ctx = this.getContext(hook.pluginId);
			const start = Date.now();

			try {
				const result = await this.executeWithTimeout(
					() => handler({ ...currentEvent }, ctx),
					hook.timeout,
				);

				if (result === false) {
					return false;
				}

				if (result && typeof result === "object") {
					currentEvent = result;
				}
			} catch (error) {
				console.error(
					`[comment:beforeCreate] Plugin "${hook.pluginId}" error (${Date.now() - start}ms):`,
					error instanceof Error ? error.message : error,
				);

				if (hook.errorPolicy === "abort") {
					throw error;
				}
			}
		}

		return currentEvent;
	}

	/**
	 * Run comment:afterCreate hooks (fire-and-forget).
	 *
	 * Errors are logged but don't propagate — they don't affect the caller.
	 */
	async runCommentAfterCreate(event: CommentAfterCreateEvent): Promise<void> {
		const hooks = this.getTypedHooks("comment:afterCreate");

		for (const hook of hooks) {
			const { handler } = hook;
			const ctx = this.getContext(hook.pluginId);

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			} catch (error) {
				console.error(
					`[comment:afterCreate] Plugin "${hook.pluginId}" error:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}

	/**
	 * Run comment:afterModerate hooks (fire-and-forget).
	 *
	 * Errors are logged but don't propagate — they don't affect the caller.
	 */
	async runCommentAfterModerate(event: CommentAfterModerateEvent): Promise<void> {
		const hooks = this.getTypedHooks("comment:afterModerate");

		for (const hook of hooks) {
			const { handler } = hook;
			const ctx = this.getContext(hook.pluginId);

			try {
				await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			} catch (error) {
				console.error(
					`[comment:afterModerate] Plugin "${hook.pluginId}" error:`,
					error instanceof Error ? error.message : error,
				);
			}
		}
	}

	// =========================================================================
	// Public Page Hooks
	// =========================================================================

	/**
	 * Run page:metadata hooks. Each handler returns contributions that are
	 * merged by the metadata collector. Errors are logged but don't propagate.
	 */
	async runPageMetadata(
		event: PageMetadataEvent,
	): Promise<Array<{ pluginId: string; contributions: PageMetadataContribution[] }>> {
		const hooks = this.getTypedHooks("page:metadata");
		const results: Array<{ pluginId: string; contributions: PageMetadataContribution[] }> = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const ctx = this.getContext(hook.pluginId);

			try {
				const result = await this.executeWithTimeout(
					() => Promise.resolve(handler(event, ctx)),
					hook.timeout,
				);

				if (result != null) {
					const contributions = Array.isArray(result) ? result : [result];
					results.push({ pluginId: hook.pluginId, contributions });
				}
			} catch (error) {
				console.error(
					`[page:metadata] Plugin "${hook.pluginId}" error:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		return results;
	}

	/**
	 * Run page:fragments hooks. Only trusted plugins should be registered
	 * for this hook. Errors are logged but don't propagate.
	 */
	async runPageFragments(
		event: PageFragmentEvent,
	): Promise<Array<{ pluginId: string; contributions: PageFragmentContribution[] }>> {
		const hooks = this.getTypedHooks("page:fragments");
		const results: Array<{ pluginId: string; contributions: PageFragmentContribution[] }> = [];

		for (const hook of hooks) {
			const { handler } = hook;
			const ctx = this.getContext(hook.pluginId);

			try {
				const result = await this.executeWithTimeout(
					() => Promise.resolve(handler(event, ctx)),
					hook.timeout,
				);

				if (result != null) {
					const contributions = Array.isArray(result) ? result : [result];
					results.push({ pluginId: hook.pluginId, contributions });
				}
			} catch (error) {
				console.error(
					`[page:fragments] Plugin "${hook.pluginId}" error:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		return results;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Check if any hooks are registered for a given name
	 */
	hasHooks(name: HookNameV2): boolean {
		const hooks = this.hooks.get(name);
		return hooks !== undefined && hooks.length > 0;
	}

	/**
	 * Get hook count for debugging
	 */
	getHookCount(name: HookNameV2): number {
		return this.hooks.get(name)?.length || 0;
	}

	/**
	 * Get all registered hook names
	 */
	getRegisteredHooks(): HookNameV2[] {
		return [...this.hooks.keys()];
	}

	// =========================================================================
	// Exclusive Hook Support
	// =========================================================================

	/**
	 * Returns hook names where at least one handler declared exclusive: true
	 */
	getRegisteredExclusiveHooks(): string[] {
		return [...this.exclusiveHookNames];
	}

	/**
	 * Check if a hook is exclusive
	 */
	isExclusiveHook(name: string): boolean {
		return this.exclusiveHookNames.has(name);
	}

	/**
	 * Set the selected provider for an exclusive hook.
	 * Called by PluginManager after resolution.
	 */
	setExclusiveSelection(hookName: string, pluginId: string): void {
		this.exclusiveSelections.set(hookName, pluginId);
	}

	/**
	 * Clear the selected provider for an exclusive hook.
	 */
	clearExclusiveSelection(hookName: string): void {
		this.exclusiveSelections.delete(hookName);
	}

	/**
	 * Get the selected provider for an exclusive hook (if any).
	 */
	getExclusiveSelection(hookName: string): string | undefined {
		return this.exclusiveSelections.get(hookName);
	}

	/**
	 * Get all plugins that registered a handler for a given exclusive hook.
	 */
	getExclusiveHookProviders(hookName: string): Array<{ pluginId: string }> {
		const hooks = this.hooks.get(hookName as HookNameV2) ?? [];
		return hooks.filter((h) => h.exclusive).map((h) => ({ pluginId: h.pluginId }));
	}

	/**
	 * Get all plugins that registered a non-exclusive handler for a given
	 * hook (e.g. `email:beforeSend`, `email:afterSend`), preserving priority
	 * order. Partitions with `getExclusiveHookProviders()`, which returns
	 * plugins whose registration is marked `exclusive: true`.
	 */
	getHookProviders(hookName: string): Array<{ pluginId: string }> {
		const hooks = this.hooks.get(hookName as HookNameV2) ?? [];
		return hooks.filter((h) => !h.exclusive).map((h) => ({ pluginId: h.pluginId }));
	}

	/**
	 * Invoke an exclusive hook — dispatch only to the selected provider.
	 * Returns null if no provider is selected or if the selected hook
	 * is not found in the pipeline.
	 *
	 * This is a generic dispatch used by the email pipeline and other
	 * exclusive hook consumers. The handler type is unknown — callers
	 * must know the expected signature.
	 *
	 * Errors are isolated: a failing handler returns an error result
	 * instead of propagating the exception to the caller.
	 */
	async invokeExclusiveHook(
		hookName: string,
		event: unknown,
	): Promise<{ result: unknown; pluginId: string; error?: Error; duration: number } | null> {
		const selectedPluginId = this.exclusiveSelections.get(hookName);
		if (!selectedPluginId) return null;

		const hooks = this.hooks.get(hookName as HookNameV2) ?? [];
		const hook = hooks.find((h) => h.pluginId === selectedPluginId && h.exclusive);
		if (!hook) return null;

		const start = Date.now();
		try {
			const ctx = this.getContext(selectedPluginId);
			const handler = hook.handler as (event: unknown, ctx: PluginContext) => Promise<unknown>;
			const result = await this.executeWithTimeout(() => handler(event, ctx), hook.timeout);
			return { result, pluginId: selectedPluginId, duration: Date.now() - start };
		} catch (error) {
			return {
				result: undefined,
				pluginId: selectedPluginId,
				error: error instanceof Error ? error : new Error(String(error)),
				duration: Date.now() - start,
			};
		}
	}
}

/**
 * Create a hook pipeline from plugins
 */
export function createHookPipeline(
	plugins: ResolvedPlugin[],
	factoryOptions?: PluginContextFactoryOptions,
): HookPipeline {
	return new HookPipeline(plugins, factoryOptions);
}

// ── Shared exclusive hook resolution ─────────────────────────────────────────

/**
 * Options for exclusive hook resolution.
 */
export interface ExclusiveHookResolutionOptions {
	pipeline: HookPipeline;
	/**
	 * Check whether a plugin ID is currently active.
	 * Used to filter providers — only active providers participate in selection.
	 */
	isActive: (pluginId: string) => boolean;
	/** Read an option value from persistent storage. */
	getOption: (key: string) => Promise<string | null>;
	/** Write an option value to persistent storage. */
	setOption: (key: string, value: string) => Promise<void>;
	/** Delete an option from persistent storage. */
	deleteOption: (key: string) => Promise<void>;
	/**
	 * Map of pluginId → hook names the plugin prefers to handle.
	 * Used as a tiebreaker when no DB selection exists and multiple providers are active.
	 */
	preferredHints?: Map<string, string[]>;
}

/** Options table key prefix for exclusive hook selections */
const EXCLUSIVE_HOOK_KEY_PREFIX = "emdash:exclusive_hook:";

/**
 * Resolve exclusive hook selections.
 *
 * Shared algorithm used by both PluginManager and EmDashRuntime:
 * 1. If a DB selection exists and that plugin is active → keep it.
 * 2. If DB selection is stale (plugin inactive/gone) → clear it.
 * 3. If no selection and only one active provider → auto-select it.
 * 4. If preferred hints match an active provider → first match wins.
 * 5. If multiple providers and no hint → leave unselected (admin must choose).
 */
export async function resolveExclusiveHooks(opts: ExclusiveHookResolutionOptions): Promise<void> {
	const { pipeline, isActive, getOption, setOption, deleteOption, preferredHints } = opts;
	const exclusiveHookNames = pipeline.getRegisteredExclusiveHooks();

	for (const hookName of exclusiveHookNames) {
		const providers = pipeline.getExclusiveHookProviders(hookName);
		const activeProviderIds = new Set(
			providers.map((p) => p.pluginId).filter((id) => isActive(id)),
		);

		const key = `${EXCLUSIVE_HOOK_KEY_PREFIX}${hookName}`;
		let currentSelection: string | null = null;
		try {
			currentSelection = await getOption(key);
		} catch {
			// Options table may not be ready
			continue;
		}

		// If selection exists and the plugin is still active → keep it
		if (currentSelection && activeProviderIds.has(currentSelection)) {
			pipeline.setExclusiveSelection(hookName, currentSelection);
			continue;
		}

		// Selection is stale or missing — clear it
		if (currentSelection) {
			try {
				await deleteOption(key);
			} catch {
				// Non-fatal
			}
		}

		// Auto-select if only one active provider
		if (activeProviderIds.size === 1) {
			const [onlyProvider] = activeProviderIds;
			try {
				await setOption(key, onlyProvider);
			} catch {
				// Non-fatal
			}
			pipeline.setExclusiveSelection(hookName, onlyProvider);
			continue;
		}

		// Check preferred hints
		if (preferredHints) {
			let found = false;
			for (const [pluginId, hooks] of preferredHints) {
				if (hooks.includes(hookName) && activeProviderIds.has(pluginId)) {
					try {
						await setOption(key, pluginId);
					} catch {
						// Non-fatal
					}
					pipeline.setExclusiveSelection(hookName, pluginId);
					found = true;
					break;
				}
			}
			if (found) continue;
		}

		// Multiple providers, no hint — leave unselected
		pipeline.clearExclusiveSelection(hookName);
	}
}
