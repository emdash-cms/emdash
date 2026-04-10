/**
 * EmDashRuntime - Core runtime for EmDash CMS
 *
 * Manages database, storage, plugins (trusted + sandboxed), hooks, and
 * provides handlers for content/media operations.
 *
 * Created once per worker lifetime, cached and reused across requests.
 */

import type { Element } from "@emdash-cms/blocks";
import { Kysely, sql, type Dialect } from "kysely";

import { validateRev } from "./api/rev.js";
import type {
	EmDashConfig,
	PluginAdminPage,
	PluginDashboardWidget,
} from "./astro/integration/runtime.js";
import type { EmDashManifest, ManifestCollection } from "./astro/types.js";
import { getAuthMode } from "./auth/mode.js";
import { isSqlite } from "./database/dialect-helpers.js";
import { runMigrations } from "./database/migrations/runner.js";
import { RevisionRepository } from "./database/repositories/revision.js";
import type { ContentItem as ContentItemInternal } from "./database/repositories/types.js";
import { normalizeMediaValue } from "./media/normalize.js";
import type { MediaProvider, MediaProviderCapabilities } from "./media/types.js";
import type { SandboxedPlugin, SandboxRunner } from "./plugins/sandbox/types.js";
import type {
	ResolvedPlugin,
	MediaItem,
	PluginManifest,
	PluginCapability,
	PluginStorageConfig,
	PublicPageContext,
	PageMetadataContribution,
	PageFragmentContribution,
} from "./plugins/types.js";
import type { FieldType } from "./schema/types.js";
import { hashString } from "./utils/hash.js";

const LEADING_SLASH_PATTERN = /^\//;

/** Combined result from a single-pass page contribution collection */
interface PageContributions {
	metadata: PageMetadataContribution[];
	fragments: PageFragmentContribution[];
}

const VALID_METADATA_KINDS = new Set(["meta", "property", "link", "jsonld"]);

/** Security-critical allowlist for link rel values from sandboxed plugins */
const VALID_LINK_REL = new Set([
	"canonical",
	"alternate",
	"author",
	"license",
	"site.standard.document",
]);

/**
 * Runtime validation for sandboxed plugin metadata contributions.
 * Sandboxed plugins return `unknown` across the RPC boundary — we must
 * verify the shape before passing to the metadata collector.
 */
function isValidMetadataContribution(c: unknown): c is PageMetadataContribution {
	if (!c || typeof c !== "object" || !("kind" in c)) return false;
	const obj = c as Record<string, unknown>;
	if (typeof obj.kind !== "string" || !VALID_METADATA_KINDS.has(obj.kind)) return false;

	switch (obj.kind) {
		case "meta":
			return typeof obj.name === "string" && typeof obj.content === "string";
		case "property":
			return typeof obj.property === "string" && typeof obj.content === "string";
		case "link":
			return (
				typeof obj.href === "string" && typeof obj.rel === "string" && VALID_LINK_REL.has(obj.rel)
			);
		case "jsonld":
			return obj.graph != null && typeof obj.graph === "object";
		default:
			return false;
	}
}

import { loadBundleFromR2 } from "./api/handlers/marketplace.js";
import { runSystemCleanup } from "./cleanup.js";
import {
	DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
	defaultCommentModerate,
} from "./comments/moderator.js";
import { OptionsRepository } from "./database/repositories/options.js";
import {
	handleContentList,
	handleContentGet,
	handleContentGetIncludingTrashed,
	handleContentCreate,
	handleContentUpdate,
	handleContentDelete,
	handleContentDuplicate,
	handleContentRestore,
	handleContentPermanentDelete,
	handleContentListTrashed,
	handleContentCountTrashed,
	handleContentPublish,
	handleContentUnpublish,
	handleContentSchedule,
	handleContentUnschedule,
	handleContentCountScheduled,
	handleContentDiscardDraft,
	handleContentCompare,
	handleContentTranslations,
	handleMediaList,
	handleMediaGet,
	handleMediaCreate,
	handleMediaUpdate,
	handleMediaDelete,
	handleRevisionList,
	handleRevisionGet,
	handleRevisionRestore,
	SchemaRegistry,
	type Database,
	type Storage,
} from "./index.js";
import { getDb } from "./loader.js";
import { CronExecutor, type InvokeCronHookFn } from "./plugins/cron.js";
import { definePlugin } from "./plugins/define-plugin.js";
import { DEV_CONSOLE_EMAIL_PLUGIN_ID, devConsoleEmailDeliver } from "./plugins/email-console.js";
import { EmailPipeline } from "./plugins/email.js";
import {
	createHookPipeline,
	resolveExclusiveHooks as resolveExclusiveHooksShared,
	type HookPipeline,
} from "./plugins/hooks.js";
import { normalizeManifestRoute } from "./plugins/manifest-schema.js";
import { extractRequestMeta, sanitizeHeadersForSandbox } from "./plugins/request-meta.js";
import { PluginRouteRegistry, type RouteMeta } from "./plugins/routes.js";
import { NodeCronScheduler } from "./plugins/scheduler/node.js";
import { PiggybackScheduler } from "./plugins/scheduler/piggyback.js";
import type { CronScheduler } from "./plugins/scheduler/types.js";
import { PluginStateRepository } from "./plugins/state.js";
import { getRequestContext } from "./request-context.js";
import { FTSManager } from "./search/fts-manager.js";

/**
 * Map schema field types to editor field kinds
 */
const FIELD_TYPE_TO_KIND: Record<FieldType, string> = {
	string: "string",
	slug: "string",
	text: "richText",
	number: "number",
	integer: "number",
	boolean: "boolean",
	datetime: "datetime",
	select: "select",
	multiSelect: "multiSelect",
	portableText: "portableText",
	image: "image",
	file: "file",
	reference: "reference",
	json: "json",
	repeater: "repeater",
};

/**
 * Sandboxed plugin entry from virtual module
 */
export interface SandboxedPluginEntry {
	id: string;
	version: string;
	options: Record<string, unknown>;
	code: string;
	/** Capabilities the plugin requests */
	capabilities: PluginCapability[];
	/** Allowed hosts for network:fetch */
	allowedHosts: string[];
	/** Declared storage collections */
	storage: PluginStorageConfig;
	/** Admin pages */
	adminPages?: Array<{ path: string; label?: string; icon?: string }>;
	/** Dashboard widgets */
	adminWidgets?: Array<{ id: string; title?: string; size?: string }>;
	/** Admin entry module */
	adminEntry?: string;
	/**
	 * Exclusive hooks this plugin should be auto-selected for.
	 * Weaker than an existing admin DB selection — config order wins when no selection exists.
	 */
	preferred?: string[];
}

/**
 * Media provider entry from virtual module
 */
export interface MediaProviderEntry {
	id: string;
	name: string;
	icon?: string;
	capabilities: MediaProviderCapabilities;
	/** Factory function to create the provider instance */
	createProvider: (ctx: MediaProviderContext) => MediaProvider;
}

/**
 * Context passed to media provider factory functions
 */
export interface MediaProviderContext {
	db: Kysely<Database>;
	storage: Storage | null;
}

/**
 * Dependencies injected from virtual modules (middleware reads these)
 */
export interface RuntimeDependencies {
	config: EmDashConfig;
	plugins: ResolvedPlugin[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	createDialect: (config: any) => Dialect;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	createStorage: ((config: any) => Storage) | null;
	sandboxEnabled: boolean;
	/** Media provider entries from virtual module */
	mediaProviderEntries?: MediaProviderEntry[];
	sandboxedPluginEntries: SandboxedPluginEntry[];
	/** Factory function matching SandboxRunnerFactory signature */
	createSandboxRunner: ((opts: { db: Kysely<Database> }) => SandboxRunner) | null;
}

/**
 * Convert a ContentItem to Record<string, unknown> for hook consumption.
 * Hooks receive the full item as a flat record.
 */
function contentItemToRecord(item: ContentItemInternal): Record<string, unknown> {
	return { ...item };
}

// Module-level caches (persist across requests within worker)
const dbCache = new Map<string, Kysely<Database>>();
let dbInitPromise: Promise<Kysely<Database>> | null = null;
const storageCache = new Map<string, Storage>();
const sandboxedPluginCache = new Map<string, SandboxedPlugin>();
const marketplacePluginKeys = new Set<string>();
/** Manifest metadata for marketplace plugins: pluginId -> manifest admin config */
const marketplaceManifestCache = new Map<
	string,
	{
		id: string;
		version: string;
		admin?: { pages?: PluginAdminPage[]; widgets?: PluginDashboardWidget[] };
	}
>();
/** Route metadata for sandboxed plugins: pluginId -> routeName -> RouteMeta */
const sandboxedRouteMetaCache = new Map<string, Map<string, RouteMeta>>();
let sandboxRunner: SandboxRunner | null = null;

/**
 * EmDashRuntime - singleton per worker
 */
export class EmDashRuntime {
	/**
	 * The singleton database instance (worker-lifetime cached).
	 * Use the `db` getter instead — it checks the request context first
	 * for per-request overrides (D1 read replica sessions, DO multi-site).
	 */
	private readonly _db: Kysely<Database>;
	readonly storage: Storage | null;
	readonly configuredPlugins: ResolvedPlugin[];
	readonly sandboxedPlugins: Map<string, SandboxedPlugin>;
	readonly sandboxedPluginEntries: SandboxedPluginEntry[];
	readonly schemaRegistry: SchemaRegistry;
	private _hooks!: HookPipeline;
	readonly config: EmDashConfig;
	readonly mediaProviders: Map<string, MediaProvider>;
	readonly mediaProviderEntries: MediaProviderEntry[];
	readonly cronExecutor: CronExecutor | null;
	readonly email: EmailPipeline | null;

	private cronScheduler: CronScheduler | null;
	private enabledPlugins: Set<string>;
	private pluginStates: Map<string, string>;

	/** Current hook pipeline. Use the `hooks` getter for external access. */
	get hooks(): HookPipeline {
		return this._hooks;
	}

	/** All plugins eligible for the hook pipeline (includes built-in plugins).
	 *  Stored so we can rebuild the pipeline when plugins are enabled/disabled. */
	private allPipelinePlugins: ResolvedPlugin[];
	/** Factory options for the hook pipeline context factory */
	private pipelineFactoryOptions: {
		db: Kysely<Database>;
		storage?: Storage;
		siteInfo?: { siteName?: string; siteUrl?: string; locale?: string };
	};
	/** Dependencies needed for exclusive hook resolution */
	private runtimeDeps: RuntimeDependencies;
	/** Mutable ref for the cron invokeCronHook closure to read the current pipeline */
	private pipelineRef!: { current: HookPipeline };

	/**
	 * Get the database instance for the current request.
	 *
	 * Checks the ALS-based request context first — middleware sets a
	 * per-request Kysely instance there for D1 read replica sessions
	 * or DO preview databases. Falls back to the singleton instance.
	 */
	get db(): Kysely<Database> {
		const ctx = getRequestContext();
		if (ctx?.db) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- db in context is set by middleware with correct type
			return ctx.db as Kysely<Database>;
		}
		return this._db;
	}

	private constructor(
		db: Kysely<Database>,
		storage: Storage | null,
		configuredPlugins: ResolvedPlugin[],
		sandboxedPlugins: Map<string, SandboxedPlugin>,
		sandboxedPluginEntries: SandboxedPluginEntry[],
		hooks: HookPipeline,
		enabledPlugins: Set<string>,
		pluginStates: Map<string, string>,
		config: EmDashConfig,
		mediaProviders: Map<string, MediaProvider>,
		mediaProviderEntries: MediaProviderEntry[],
		cronExecutor: CronExecutor | null,
		cronScheduler: CronScheduler | null,
		emailPipeline: EmailPipeline | null,
		allPipelinePlugins: ResolvedPlugin[],
		pipelineFactoryOptions: {
			db: Kysely<Database>;
			storage?: Storage;
			siteInfo?: { siteName?: string; siteUrl?: string; locale?: string };
		},
		runtimeDeps: RuntimeDependencies,
		pipelineRef: { current: HookPipeline },
	) {
		this._db = db;
		this.storage = storage;
		this.configuredPlugins = configuredPlugins;
		this.sandboxedPlugins = sandboxedPlugins;
		this.sandboxedPluginEntries = sandboxedPluginEntries;
		this.schemaRegistry = new SchemaRegistry(db);
		this._hooks = hooks;
		this.enabledPlugins = enabledPlugins;
		this.pluginStates = pluginStates;
		this.config = config;
		this.mediaProviders = mediaProviders;
		this.mediaProviderEntries = mediaProviderEntries;
		this.cronExecutor = cronExecutor;
		this.cronScheduler = cronScheduler;
		this.email = emailPipeline;
		this.allPipelinePlugins = allPipelinePlugins;
		this.pipelineFactoryOptions = pipelineFactoryOptions;
		this.runtimeDeps = runtimeDeps;
		this.pipelineRef = pipelineRef;
	}

	/**
	 * Get the sandbox runner instance (for marketplace install/update)
	 */
	getSandboxRunner(): SandboxRunner | null {
		return sandboxRunner;
	}

	/**
	 * Tick the cron system from request context (piggyback mode).
	 * Call this from middleware on each request to ensure cron tasks
	 * execute even when no dedicated scheduler is available.
	 */
	tickCron(): void {
		if (this.cronScheduler instanceof PiggybackScheduler) {
			this.cronScheduler.onRequest();
		}
	}

	/**
	 * Stop the cron scheduler gracefully.
	 * Call during worker shutdown or hot-reload.
	 */
	async stopCron(): Promise<void> {
		if (this.cronScheduler) {
			await this.cronScheduler.stop();
		}
	}

	/**
	 * Update in-memory plugin status and rebuild the hook pipeline.
	 *
	 * Rebuilding the pipeline ensures disabled plugins' hooks stop firing
	 * and re-enabled plugins' hooks start firing again without a restart.
	 * Exclusive hook selections are re-resolved after each rebuild.
	 */
	async setPluginStatus(pluginId: string, status: "active" | "inactive"): Promise<void> {
		this.pluginStates.set(pluginId, status);
		if (status === "active") {
			this.enabledPlugins.add(pluginId);
		} else {
			this.enabledPlugins.delete(pluginId);
		}

		await this.rebuildHookPipeline();
	}

	/**
	 * Rebuild the hook pipeline from the current set of enabled plugins.
	 *
	 * Filters `allPipelinePlugins` to only those in `enabledPlugins`,
	 * creates a fresh HookPipeline, re-resolves exclusive hook selections,
	 * and re-wires the context factory so existing references (cron
	 * callbacks, email pipeline) use the new pipeline.
	 */
	private async rebuildHookPipeline(): Promise<void> {
		const enabledList = this.allPipelinePlugins.filter((p) => this.enabledPlugins.has(p.id));
		const newPipeline = createHookPipeline(enabledList, this.pipelineFactoryOptions);

		// Re-resolve exclusive hooks against the new pipeline
		await EmDashRuntime.resolveExclusiveHooks(newPipeline, this.db, this.runtimeDeps);

		// Carry over context factory options from the old pipeline so that
		// email, cron reschedule, and other wired-in options are preserved.
		// The old pipeline's contextFactoryOptions were built up incrementally
		// via setContextFactory calls during create(). We replay them here.
		if (this.email) {
			newPipeline.setContextFactory({ db: this.db, emailPipeline: this.email });
		}
		if (this.cronScheduler) {
			const scheduler = this.cronScheduler;
			newPipeline.setContextFactory({
				cronReschedule: () => scheduler.reschedule(),
			});
		}

		// Update the email pipeline to use the new hook pipeline
		if (this.email) {
			this.email.setPipeline(newPipeline);
		}

		// Update the mutable ref so the cron closure dispatches through
		// the new pipeline without needing to reconstruct the CronExecutor.
		this.pipelineRef.current = newPipeline;

		this._hooks = newPipeline;
	}

	/**
	 * Synchronize marketplace plugin runtime state with DB + storage.
	 *
	 * Ensures install/update/uninstall changes take effect immediately in the
	 * current worker: loads newly active plugins and removes uninstalled ones.
	 */
	async syncMarketplacePlugins(): Promise<void> {
		if (!this.config.marketplace || !this.storage) return;
		if (!sandboxRunner || !sandboxRunner.isAvailable()) return;

		try {
			const stateRepo = new PluginStateRepository(this.db);
			const marketplaceStates = await stateRepo.getMarketplacePlugins();

			const desired = new Map<string, string>();
			for (const state of marketplaceStates) {
				this.pluginStates.set(state.pluginId, state.status);
				if (state.status === "active") {
					this.enabledPlugins.add(state.pluginId);
				} else {
					this.enabledPlugins.delete(state.pluginId);
				}
				if (state.status !== "active") continue;
				desired.set(state.pluginId, state.marketplaceVersion ?? state.version);
			}

			// Remove uninstalled or no-longer-active marketplace plugins from memory.
			const keysToRemove: string[] = [];
			for (const key of marketplacePluginKeys) {
				const [pluginId] = key.split(":");
				if (!pluginId) continue;
				const desiredVersion = desired.get(pluginId);
				if (desiredVersion && key === `${pluginId}:${desiredVersion}`) continue;
				keysToRemove.push(key);
			}

			for (const key of keysToRemove) {
				const [pluginId] = key.split(":");
				if (!pluginId) continue;
				const desiredVersion = desired.get(pluginId);
				if (!desiredVersion) {
					this.pluginStates.delete(pluginId);
					this.enabledPlugins.delete(pluginId);
				}

				const existing = sandboxedPluginCache.get(key);
				if (existing) {
					try {
						await existing.terminate();
					} catch (error) {
						console.warn(`EmDash: Failed to terminate sandboxed plugin ${key}:`, error);
					}
				}

				sandboxedPluginCache.delete(key);
				this.sandboxedPlugins.delete(key);
				marketplacePluginKeys.delete(key);
				if (pluginId) {
					sandboxedRouteMetaCache.delete(pluginId);
					marketplaceManifestCache.delete(pluginId);
				}
			}

			// Load newly active marketplace plugins.
			for (const [pluginId, version] of desired) {
				const key = `${pluginId}:${version}`;
				if (sandboxedPluginCache.has(key)) {
					marketplacePluginKeys.add(key);
					continue;
				}

				const bundle = await loadBundleFromR2(this.storage, pluginId, version);
				if (!bundle) {
					console.warn(`EmDash: Marketplace plugin ${pluginId}@${version} not found in R2`);
					continue;
				}

				const loaded = await sandboxRunner.load(bundle.manifest, bundle.backendCode);
				sandboxedPluginCache.set(key, loaded);
				this.sandboxedPlugins.set(key, loaded);
				marketplacePluginKeys.add(key);

				// Cache manifest admin config for getManifest()
				marketplaceManifestCache.set(pluginId, {
					id: bundle.manifest.id,
					version: bundle.manifest.version,
					admin: bundle.manifest.admin,
				});

				// Cache route metadata from manifest for auth decisions
				if (bundle.manifest.routes.length > 0) {
					const routeMetaMap = new Map<string, RouteMeta>();
					for (const entry of bundle.manifest.routes) {
						const normalized = normalizeManifestRoute(entry);
						routeMetaMap.set(normalized.name, { public: normalized.public === true });
					}
					sandboxedRouteMetaCache.set(pluginId, routeMetaMap);
				} else {
					sandboxedRouteMetaCache.delete(pluginId);
				}
			}
		} catch (error) {
			console.error("EmDash: Failed to sync marketplace plugins:", error);
		}
	}

	/**
	 * Create and initialize the runtime
	 */
	static async create(deps: RuntimeDependencies): Promise<EmDashRuntime> {
		// Initialize database
		const db = await EmDashRuntime.getDatabase(deps);

		// Verify and repair FTS indexes (auto-heal crash corruption)
		// FTS5 is SQLite-only; on other dialects, search is a no-op until
		// the pluggable SearchProvider work lands.
		if (isSqlite(db)) {
			try {
				const ftsManager = new FTSManager(db);
				const repaired = await ftsManager.verifyAndRepairAll();
				if (repaired > 0) {
					console.log(`Repaired ${repaired} corrupted FTS index(es) at startup`);
				}
			} catch {
				// FTS tables may not exist yet (pre-setup). Non-fatal.
			}
		}

		// Initialize storage
		const storage = EmDashRuntime.getStorage(deps);

		// Fetch plugin states from database
		let pluginStates: Map<string, string> = new Map();
		try {
			const states = await db.selectFrom("_plugin_state").select(["plugin_id", "status"]).execute();
			pluginStates = new Map(states.map((s) => [s.plugin_id, s.status]));
		} catch {
			// Plugin state table may not exist yet
		}

		// Build set of enabled plugins
		const enabledPlugins = new Set<string>();
		for (const plugin of deps.plugins) {
			const status = pluginStates.get(plugin.id);
			if (status === undefined || status === "active") {
				enabledPlugins.add(plugin.id);
			}
		}

		// Load site info for plugin context extensions
		let siteInfo: { siteName?: string; siteUrl?: string; locale?: string } | undefined;
		try {
			const optionsRepo = new OptionsRepository(db);
			const siteName = await optionsRepo.get<string>("emdash:site_title");
			const siteUrl = await optionsRepo.get<string>("emdash:site_url");
			const locale = await optionsRepo.get<string>("emdash:locale");
			siteInfo = {
				siteName: siteName ?? undefined,
				siteUrl: siteUrl ?? undefined,
				locale: locale ?? undefined,
			};
		} catch {
			// Options table may not exist yet (pre-setup)
		}

		// Build the full list of pipeline-eligible plugins: all configured
		// plugins (regardless of current enabled status) plus built-in plugins.
		// rebuildHookPipeline() filters this to only enabled plugins.
		const allPipelinePlugins: ResolvedPlugin[] = [...deps.plugins];

		// In dev mode, register a built-in console email provider.
		// It participates in exclusive hook resolution like any other plugin —
		// auto-selected when it's the sole provider, overridden when a real one is configured.
		// Gated by import.meta.env.DEV to prevent silent email loss in production.
		if (import.meta.env.DEV) {
			try {
				const devConsolePlugin = definePlugin({
					id: DEV_CONSOLE_EMAIL_PLUGIN_ID,
					version: "0.0.0",
					capabilities: ["email:provide"],
					hooks: {
						"email:deliver": {
							exclusive: true,
							handler: devConsoleEmailDeliver,
						},
					},
				});
				allPipelinePlugins.push(devConsolePlugin);
				// Built-in plugins are always enabled
				enabledPlugins.add(devConsolePlugin.id);
			} catch (error) {
				console.warn("[email] Failed to register dev console email provider:", error);
			}
		}

		// Register built-in default comment moderator.
		// Always present — auto-selected as the sole comment:moderate provider
		// unless a plugin (e.g. AI moderation) provides its own.
		try {
			const defaultModeratorPlugin = definePlugin({
				id: DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
				version: "0.0.0",
				capabilities: ["read:users"],
				hooks: {
					"comment:moderate": {
						exclusive: true,
						handler: defaultCommentModerate,
					},
				},
			});
			allPipelinePlugins.push(defaultModeratorPlugin);
			// Built-in plugins are always enabled
			enabledPlugins.add(defaultModeratorPlugin.id);
		} catch (error) {
			console.warn("[comments] Failed to register default moderator:", error);
		}

		// Filter to currently enabled plugins for the initial pipeline
		const enabledPluginList = allPipelinePlugins.filter((p) => enabledPlugins.has(p.id));

		// Create hook pipeline
		const pipelineFactoryOptions = {
			db,
			storage: storage ?? undefined,
			siteInfo,
		};
		const pipeline = createHookPipeline(enabledPluginList, pipelineFactoryOptions);

		// Load sandboxed plugins (build-time)
		const sandboxedPlugins = await EmDashRuntime.loadSandboxedPlugins(deps, db);

		// Cold-start: load marketplace-installed plugins from site R2
		if (deps.config.marketplace && storage) {
			await EmDashRuntime.loadMarketplacePlugins(db, storage, deps, sandboxedPlugins);
		}

		// Initialize media providers
		const mediaProviders = new Map<string, MediaProvider>();
		const mediaProviderEntries = deps.mediaProviderEntries ?? [];
		const providerContext: MediaProviderContext = { db, storage };

		for (const entry of mediaProviderEntries) {
			try {
				const provider = entry.createProvider(providerContext);
				mediaProviders.set(entry.id, provider);
			} catch (error) {
				console.warn(`Failed to initialize media provider "${entry.id}":`, error);
			}
		}

		// Resolve exclusive hooks — auto-select providers and sync with DB
		await EmDashRuntime.resolveExclusiveHooks(pipeline, db, deps);

		// ── Email pipeline ───────────────────────────────────────────────
		// The email pipeline orchestrates beforeSend → deliver → afterSend.
		// The dev console provider was registered above and will be auto-selected
		// by resolveExclusiveHooks if it's the sole email:deliver provider.
		const emailPipeline = new EmailPipeline(pipeline);

		// Wire email send into sandbox runner (created earlier but without
		// email pipeline since it didn't exist yet)
		if (sandboxRunner) {
			sandboxRunner.setEmailSend((message, pluginId) => emailPipeline.send(message, pluginId));
		}

		// ── Cron system ──────────────────────────────────────────────────
		// Create executor with a hook dispatch function that uses the pipeline.
		// The callback reads from a mutable ref so that rebuildHookPipeline()
		// can swap the pipeline without reconstructing the CronExecutor.
		const pipelineRef = { current: pipeline };
		const invokeCronHook: InvokeCronHookFn = async (pluginId, event) => {
			const result = await pipelineRef.current.invokeCronHook(pluginId, event);
			if (!result.success && result.error) {
				throw result.error;
			}
		};

		// Wire email pipeline into context factory (independent of cron —
		// must not be inside the cron try/catch or ctx.email breaks when cron fails)
		pipeline.setContextFactory({ db, emailPipeline });

		let cronExecutor: CronExecutor | null = null;
		let cronScheduler: CronScheduler | null = null;

		try {
			cronExecutor = new CronExecutor(db, invokeCronHook);

			// Recover stale locks from previous crashes
			const recovered = await cronExecutor.recoverStaleLocks();
			if (recovered > 0) {
				console.log(`[cron] Recovered ${recovered} stale task lock(s)`);
			}

			// Detect platform and create appropriate scheduler.
			// On Cloudflare Workers, setTimeout is available but unreliable for
			// long durations — use PiggybackScheduler as default.
			// In Node/Bun, use NodeCronScheduler with real timers.
			const isWorkersRuntime =
				typeof globalThis.navigator !== "undefined" &&
				globalThis.navigator.userAgent === "Cloudflare-Workers";

			if (isWorkersRuntime) {
				cronScheduler = new PiggybackScheduler(cronExecutor);
			} else {
				cronScheduler = new NodeCronScheduler(cronExecutor);
			}

			// Register system cleanup to run alongside each scheduler tick.
			// Pass storage so cleanupPendingUploads can delete orphaned files.
			cronScheduler.setSystemCleanup(async () => {
				try {
					await runSystemCleanup(db, storage ?? undefined);
				} catch (error) {
					// Non-fatal -- individual cleanup failures are already logged
					// by runSystemCleanup. This catches unexpected errors.
					console.error("[cleanup] System cleanup failed:", error);
				}
			});

			// Add cron reschedule callback (merges with existing factory options)
			pipeline.setContextFactory({
				cronReschedule: () => cronScheduler?.reschedule(),
			});

			// Start the scheduler
			await cronScheduler.start();
		} catch (error) {
			console.warn("[cron] Failed to initialize cron system:", error);
			// Non-fatal — CMS works without cron
		}

		return new EmDashRuntime(
			db,
			storage,
			deps.plugins,
			sandboxedPlugins,
			deps.sandboxedPluginEntries,
			pipeline,
			enabledPlugins,
			pluginStates,
			deps.config,
			mediaProviders,
			mediaProviderEntries,
			cronExecutor,
			cronScheduler,
			emailPipeline,
			allPipelinePlugins,
			pipelineFactoryOptions,
			deps,
			pipelineRef,
		);
	}

	/**
	 * Get a media provider by ID
	 */
	getMediaProvider(providerId: string): MediaProvider | undefined {
		return this.mediaProviders.get(providerId);
	}

	/**
	 * Get all media provider entries (for admin UI)
	 */
	getMediaProviderList(): Array<{
		id: string;
		name: string;
		icon?: string;
		capabilities: MediaProviderCapabilities;
	}> {
		return this.mediaProviderEntries.map((e) => ({
			id: e.id,
			name: e.name,
			icon: e.icon,
			capabilities: e.capabilities,
		}));
	}

	/**
	 * Get or create database instance
	 */
	private static async getDatabase(deps: RuntimeDependencies): Promise<Kysely<Database>> {
		// If a per-request DB override is set (e.g. by the playground middleware
		// which runs before the runtime init), use that directly. This allows
		// the runtime to initialize against the real DO database instead of
		// the dummy singleton dialect.
		const ctx = getRequestContext();
		if (ctx?.db) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- db in context is typed as unknown to avoid circular deps
			return ctx.db as Kysely<Database>;
		}

		const dbConfig = deps.config.database;

		// If no database configured in integration, try to get from loader
		if (!dbConfig) {
			try {
				return await getDb();
			} catch {
				throw new Error(
					"EmDash database not configured. Either configure database in astro.config.mjs or use emdashLoader in live.config.ts",
				);
			}
		}

		const cacheKey = dbConfig.entrypoint;

		// Return cached instance if available
		const cached = dbCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		// Use initialization lock to prevent race conditions.
		// Sharing this promise across requests is safe because the Kysely instance
		// doesn't hold a request-scoped resource — the DO dialect uses a getStub()
		// factory that creates a fresh stub per query execution.
		if (dbInitPromise) {
			return dbInitPromise;
		}

		dbInitPromise = (async () => {
			const dialect = deps.createDialect(dbConfig.config);
			const db = new Kysely<Database>({ dialect });

			await runMigrations(db);

			// Auto-seed schema if no collections exist and setup hasn't run.
			// This covers first-load on sites that skip the setup wizard.
			// Dev-bypass and the wizard apply seeds explicitly.
			try {
				const [collectionCount, setupOption] = await Promise.all([
					db
						.selectFrom("_emdash_collections")
						.select((eb) => eb.fn.countAll<number>().as("count"))
						.executeTakeFirstOrThrow(),
					db
						.selectFrom("options")
						.select("value")
						.where("name", "=", "emdash:setup_complete")
						.executeTakeFirst(),
				]);

				const setupDone = (() => {
					try {
						return setupOption && JSON.parse(setupOption.value) === true;
					} catch {
						return false;
					}
				})();

				if (collectionCount.count === 0 && !setupDone) {
					const { applySeed } = await import("./seed/apply.js");
					const { loadSeed } = await import("./seed/load.js");
					const { validateSeed } = await import("./seed/validate.js");

					const seed = await loadSeed();
					const validation = validateSeed(seed);
					if (validation.valid) {
						await applySeed(db, seed, { onConflict: "skip" });
						console.log("Auto-seeded default collections");
					}
				}
			} catch {
				// Tables may not exist yet. Non-fatal.
			}

			dbCache.set(cacheKey, db);
			return db;
		})();

		try {
			return await dbInitPromise;
		} finally {
			dbInitPromise = null;
		}
	}

	/**
	 * Get or create storage instance
	 */
	private static getStorage(deps: RuntimeDependencies): Storage | null {
		const storageConfig = deps.config.storage;
		if (!storageConfig || !deps.createStorage) {
			return null;
		}

		const cacheKey = storageConfig.entrypoint;
		const cached = storageCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const storage = deps.createStorage(storageConfig.config);
		storageCache.set(cacheKey, storage);
		return storage;
	}

	/**
	 * Load sandboxed plugins using SandboxRunner
	 */
	private static async loadSandboxedPlugins(
		deps: RuntimeDependencies,
		db: Kysely<Database>,
	): Promise<Map<string, SandboxedPlugin>> {
		// Return cached plugins if already loaded
		if (sandboxedPluginCache.size > 0) {
			return sandboxedPluginCache;
		}

		// Check if sandboxing is enabled
		if (!deps.sandboxEnabled || deps.sandboxedPluginEntries.length === 0) {
			return sandboxedPluginCache;
		}

		// Create sandbox runner if not exists
		if (!sandboxRunner && deps.createSandboxRunner) {
			sandboxRunner = deps.createSandboxRunner({ db });
		}

		if (!sandboxRunner) {
			return sandboxedPluginCache;
		}

		// Check if the runner is actually available (has required bindings)
		if (!sandboxRunner.isAvailable()) {
			console.warn(
				"EmDash: Plugin sandbox is configured but not available on this platform. " +
					"Sandboxed plugins will not be loaded. " +
					"If using @emdash-cms/workerd/sandbox, ensure workerd is installed.",
			);
			return sandboxedPluginCache;
		}

		// Load each sandboxed plugin
		for (const entry of deps.sandboxedPluginEntries) {
			const pluginKey = `${entry.id}:${entry.version}`;
			if (sandboxedPluginCache.has(pluginKey)) {
				continue;
			}

			try {
				// Build manifest from entry's declared config
				const manifest: PluginManifest = {
					id: entry.id,
					version: entry.version,
					capabilities: entry.capabilities ?? [],
					allowedHosts: entry.allowedHosts ?? [],
					storage: entry.storage ?? {},
					hooks: [],
					routes: [],
					admin: {},
				};

				const plugin = await sandboxRunner.load(manifest, entry.code);
				sandboxedPluginCache.set(pluginKey, plugin);
				console.log(
					`EmDash: Loaded sandboxed plugin ${pluginKey} with capabilities: [${manifest.capabilities.join(", ")}]`,
				);
			} catch (error) {
				console.error(`EmDash: Failed to load sandboxed plugin ${entry.id}:`, error);
			}
		}

		return sandboxedPluginCache;
	}

	/**
	 * Cold-start: load marketplace-installed plugins from site-local R2 storage
	 *
	 * Queries _plugin_state for source='marketplace' rows, fetches each bundle
	 * from R2, and loads via SandboxRunner.
	 */
	private static async loadMarketplacePlugins(
		db: Kysely<Database>,
		storage: Storage,
		deps: RuntimeDependencies,
		cache: Map<string, SandboxedPlugin>,
	): Promise<void> {
		// Ensure sandbox runner exists
		if (!sandboxRunner && deps.createSandboxRunner) {
			sandboxRunner = deps.createSandboxRunner({ db });
		}
		if (!sandboxRunner || !sandboxRunner.isAvailable()) {
			return;
		}

		try {
			const stateRepo = new PluginStateRepository(db);
			const marketplacePlugins = await stateRepo.getMarketplacePlugins();

			for (const plugin of marketplacePlugins) {
				if (plugin.status !== "active") continue;

				const version = plugin.marketplaceVersion ?? plugin.version;
				const pluginKey = `${plugin.pluginId}:${version}`;

				// Skip if already loaded (shouldn't happen, but guard)
				if (cache.has(pluginKey)) continue;

				try {
					const bundle = await loadBundleFromR2(storage, plugin.pluginId, version);
					if (!bundle) {
						console.warn(
							`EmDash: Marketplace plugin ${plugin.pluginId}@${version} not found in R2`,
						);
						continue;
					}

					const loaded = await sandboxRunner.load(bundle.manifest, bundle.backendCode);
					cache.set(pluginKey, loaded);
					marketplacePluginKeys.add(pluginKey);

					// Cache manifest admin config for getManifest()
					marketplaceManifestCache.set(plugin.pluginId, {
						id: bundle.manifest.id,
						version: bundle.manifest.version,
						admin: bundle.manifest.admin,
					});

					// Cache route metadata from manifest for auth decisions
					if (bundle.manifest.routes.length > 0) {
						const routeMeta = new Map<string, RouteMeta>();
						for (const entry of bundle.manifest.routes) {
							const normalized = normalizeManifestRoute(entry);
							routeMeta.set(normalized.name, { public: normalized.public === true });
						}
						sandboxedRouteMetaCache.set(plugin.pluginId, routeMeta);
					}

					console.log(
						`EmDash: Loaded marketplace plugin ${pluginKey} with capabilities: [${bundle.manifest.capabilities.join(", ")}]`,
					);
				} catch (error) {
					console.error(`EmDash: Failed to load marketplace plugin ${plugin.pluginId}:`, error);
				}
			}
		} catch {
			// _plugin_state table may not exist yet (pre-migration)
		}
	}

	/**
	 * Resolve exclusive hook selections on startup.
	 *
	 * Delegates to the shared resolveExclusiveHooks() in hooks.ts.
	 * The runtime version considers all pipeline providers as "active" since
	 * the pipeline was already built from only active/enabled plugins.
	 */
	private static async resolveExclusiveHooks(
		pipeline: HookPipeline,
		db: Kysely<Database>,
		deps: RuntimeDependencies,
	): Promise<void> {
		const exclusiveHookNames = pipeline.getRegisteredExclusiveHooks();
		if (exclusiveHookNames.length === 0) return;

		let optionsRepo: OptionsRepository;
		try {
			optionsRepo = new OptionsRepository(db);
		} catch {
			return; // Options table may not exist yet
		}

		// Build preferred hints from sandboxed plugin entries
		const preferredHints = new Map<string, string[]>();
		for (const entry of deps.sandboxedPluginEntries) {
			if (entry.preferred && entry.preferred.length > 0) {
				preferredHints.set(entry.id, entry.preferred);
			}
		}

		// The pipeline was created from only enabled plugins, so all providers
		// in it are active. The isActive check always returns true.
		await resolveExclusiveHooksShared({
			pipeline,
			isActive: () => true,
			getOption: (key) => optionsRepo.get<string>(key),
			setOption: (key, value) => optionsRepo.set(key, value),
			deleteOption: async (key) => {
				await optionsRepo.delete(key);
			},
			preferredHints,
		});
	}

	// =========================================================================
	// Manifest
	// =========================================================================

	/**
	 * Build the manifest (rebuilt on each request for freshness)
	 */
	async getManifest(): Promise<EmDashManifest> {
		// Build collections from database.
		// Use this.db (ALS-aware getter) so playground mode picks up the
		// per-session DO database instead of the hardcoded singleton.
		const manifestCollections: Record<string, ManifestCollection> = {};
		try {
			const registry = new SchemaRegistry(this.db);
			const dbCollections = await registry.listCollections();
			for (const collection of dbCollections) {
				const collectionWithFields = await registry.getCollectionWithFields(collection.slug);
				const fields: Record<
					string,
					{
						kind: string;
						label?: string;
						required?: boolean;
						widget?: string;
						options?: Array<{ value: string; label: string }>;
					}
				> = {};

				if (collectionWithFields?.fields) {
					for (const field of collectionWithFields.fields) {
						const entry: (typeof fields)[string] = {
							kind: FIELD_TYPE_TO_KIND[field.type] ?? "string",
							label: field.label,
							required: field.required,
						};
						if (field.widget) entry.widget = field.widget;
						// Include select/multiSelect options from validation
						if (field.validation?.options) {
							entry.options = field.validation.options.map((v) => ({
								value: v,
								label: v.charAt(0).toUpperCase() + v.slice(1),
							}));
						}
						// Include full validation for repeater fields (subFields, minItems, maxItems)
						if (field.type === "repeater" && field.validation) {
							(entry as Record<string, unknown>).validation = field.validation;
						}
						fields[field.slug] = entry;
					}
				}

				manifestCollections[collection.slug] = {
					label: collection.label,
					labelSingular: collection.labelSingular || collection.label,
					supports: collection.supports || [],
					hasSeo: collection.hasSeo,
					urlPattern: collection.urlPattern,
					fields,
				};
			}
		} catch (error) {
			console.debug("EmDash: Could not load database collections:", error);
		}

		// Build plugins manifest
		const manifestPlugins: Record<
			string,
			{
				version?: string;
				enabled?: boolean;
				sandboxed?: boolean;
				adminMode?: "react" | "blocks" | "none";
				adminPages?: Array<{ path: string; label?: string; icon?: string }>;
				dashboardWidgets?: Array<{
					id: string;
					title?: string;
					size?: string;
				}>;
				portableTextBlocks?: Array<{
					type: string;
					label: string;
					icon?: string;
					description?: string;
					placeholder?: string;
					fields?: Element[];
				}>;
				fieldWidgets?: Array<{
					name: string;
					label: string;
					fieldTypes: string[];
					elements?: Element[];
				}>;
			}
		> = {};

		for (const plugin of this.configuredPlugins) {
			const status = this.pluginStates.get(plugin.id);
			const enabled = status === undefined || status === "active";

			// Determine admin mode: has admin entry → react, has pages/widgets → blocks, else none
			const hasAdminEntry = !!plugin.admin?.entry;
			const hasAdminPages = (plugin.admin?.pages?.length ?? 0) > 0;
			const hasWidgets = (plugin.admin?.widgets?.length ?? 0) > 0;
			let adminMode: "react" | "blocks" | "none" = "none";
			if (hasAdminEntry) {
				adminMode = "react";
			} else if (hasAdminPages || hasWidgets) {
				adminMode = "blocks";
			}

			manifestPlugins[plugin.id] = {
				version: plugin.version,
				enabled,
				adminMode,
				adminPages: plugin.admin?.pages,
				dashboardWidgets: plugin.admin?.widgets,
				portableTextBlocks: plugin.admin?.portableTextBlocks,
				fieldWidgets: plugin.admin?.fieldWidgets,
			};
		}

		// Add sandboxed plugins (use entries for admin config)
		// TODO: sandboxed plugins need fieldWidgets extracted from their manifest
		// to support Block Kit field widgets. Currently only trusted plugins carry
		// fieldWidgets through the admin.fieldWidgets path.
		for (const entry of this.sandboxedPluginEntries) {
			const status = this.pluginStates.get(entry.id);
			const enabled = status === undefined || status === "active";

			const hasAdminPages = (entry.adminPages?.length ?? 0) > 0;
			const hasWidgets = (entry.adminWidgets?.length ?? 0) > 0;

			manifestPlugins[entry.id] = {
				version: entry.version,
				enabled,
				sandboxed: true,
				adminMode: hasAdminPages || hasWidgets ? "blocks" : "none",
				adminPages: entry.adminPages,
				dashboardWidgets: entry.adminWidgets,
			};
		}

		// Add marketplace-installed plugins (dynamically loaded from R2)
		for (const [pluginId, meta] of marketplaceManifestCache) {
			// Skip if already included from build-time config
			if (manifestPlugins[pluginId]) continue;

			const status = this.pluginStates.get(pluginId);
			const enabled = status === "active";

			const pages = meta.admin?.pages;
			const widgets = meta.admin?.widgets;
			const hasAdminPages = (pages?.length ?? 0) > 0;
			const hasWidgets = (widgets?.length ?? 0) > 0;

			manifestPlugins[pluginId] = {
				version: meta.version,
				enabled,
				sandboxed: true,
				adminMode: hasAdminPages || hasWidgets ? "blocks" : "none",
				adminPages: pages,
				dashboardWidgets: widgets,
			};
		}

		// Generate hash from both collections and plugins so cache invalidates
		// when plugins are enabled/disabled or their config changes
		const manifestHash = await hashString(
			JSON.stringify(manifestCollections) + JSON.stringify(manifestPlugins),
		);

		// Determine auth mode
		const authMode = getAuthMode(this.config);
		const authModeValue = authMode.type === "external" ? authMode.providerType : "passkey";

		// Include i18n config if enabled
		const { getI18nConfig, isI18nEnabled } = await import("./i18n/config.js");
		const i18nConfig = getI18nConfig();
		const i18n =
			isI18nEnabled() && i18nConfig
				? { defaultLocale: i18nConfig.defaultLocale, locales: i18nConfig.locales }
				: undefined;

		return {
			version: "0.1.0",
			hash: manifestHash,
			collections: manifestCollections,
			plugins: manifestPlugins,
			authMode: authModeValue,
			i18n,
			marketplace: !!this.config.marketplace,
		};
	}

	/**
	 * Invalidate the cached manifest (no-op now that we don't cache).
	 * Kept for API compatibility.
	 */
	invalidateManifest(): void {
		// No-op - manifest is rebuilt on each request
	}

	// =========================================================================
	// Content Handlers
	// =========================================================================

	async handleContentList(
		collection: string,
		params: {
			cursor?: string;
			limit?: number;
			status?: string;
			orderBy?: string;
			order?: "asc" | "desc";
			locale?: string;
		},
	) {
		return handleContentList(this.db, collection, params);
	}

	async handleContentGet(collection: string, id: string, locale?: string) {
		return handleContentGet(this.db, collection, id, locale);
	}

	async handleContentGetIncludingTrashed(collection: string, id: string, locale?: string) {
		return handleContentGetIncludingTrashed(this.db, collection, id, locale);
	}

	async handleContentCreate(
		collection: string,
		body: {
			data: Record<string, unknown>;
			slug?: string;
			status?: string;
			authorId?: string;
			bylines?: Array<{ bylineId: string; roleLabel?: string | null }>;
			locale?: string;
			translationOf?: string;
		},
	) {
		// Run beforeSave hooks (trusted plugins)
		let processedData = body.data;
		if (this.hooks.hasHooks("content:beforeSave")) {
			const hookResult = await this.hooks.runContentBeforeSave(body.data, collection, true);
			processedData = hookResult.content;
		}

		// Run beforeSave hooks (sandboxed plugins)
		processedData = await this.runSandboxedBeforeSave(processedData, collection, true);

		// Normalize media fields (fill dimensions, storageKey, etc.)
		processedData = await this.normalizeMediaFields(collection, processedData);

		// Create the content
		const result = await handleContentCreate(this.db, collection, {
			...body,
			data: processedData,
			authorId: body.authorId,
			bylines: body.bylines,
		});

		// Run afterSave hooks (fire-and-forget)
		if (result.success && result.data) {
			this.runAfterSaveHooks(contentItemToRecord(result.data.item), collection, true);
		}

		return result;
	}

	async handleContentUpdate(
		collection: string,
		id: string,
		body: {
			data?: Record<string, unknown>;
			slug?: string;
			status?: string;
			authorId?: string | null;
			bylines?: Array<{ bylineId: string; roleLabel?: string | null }>;
			/** Skip revision creation (used by autosave) */
			skipRevision?: boolean;
			_rev?: string;
		},
	) {
		// Resolve slug → ID if needed (before any lookups)
		const { ContentRepository } = await import("./database/repositories/content.js");
		const repo = new ContentRepository(this.db);
		const resolvedItem = await repo.findByIdOrSlug(collection, id);
		const resolvedId = resolvedItem?.id ?? id;

		// Validate _rev early — before draft revision writes which modify updated_at.
		// After validation, strip _rev so the handler doesn't double-check against
		// the now-modified timestamp.
		if (body._rev) {
			if (!resolvedItem) {
				return {
					success: false as const,
					error: { code: "NOT_FOUND", message: `Content item not found: ${id}` },
				};
			}
			const revCheck = validateRev(body._rev, resolvedItem);
			if (!revCheck.valid) {
				return {
					success: false as const,
					error: { code: "CONFLICT", message: revCheck.message },
				};
			}
		}
		const { _rev: _discardedRev, ...bodyWithoutRev } = body;

		// Run beforeSave hooks if data is provided
		let processedData = bodyWithoutRev.data;
		if (bodyWithoutRev.data) {
			if (this.hooks.hasHooks("content:beforeSave")) {
				const hookResult = await this.hooks.runContentBeforeSave(
					bodyWithoutRev.data,
					collection,
					false,
				);
				processedData = hookResult.content;
			}

			// Run sandboxed beforeSave hooks
			processedData = await this.runSandboxedBeforeSave(processedData!, collection, false);

			// Normalize media fields (fill dimensions, storageKey, etc.)
			processedData = await this.normalizeMediaFields(collection, processedData);
		}

		// Draft-aware revision handling (if collection supports revisions)
		// Content table columns = published data (never written by saves).
		// Draft data lives only in the revisions table.
		let usesDraftRevisions = false;
		if (processedData) {
			try {
				const collectionInfo = await this.schemaRegistry.getCollectionWithFields(collection);
				if (collectionInfo?.supports?.includes("revisions")) {
					usesDraftRevisions = true;
					const revisionRepo = new RevisionRepository(this.db);
					// Re-fetch to get latest state (resolvedItem may be stale after _rev check)
					const existing = await repo.findById(collection, resolvedId);

					if (existing) {
						// Build the draft data: merge with existing draft revision if one exists,
						// otherwise merge with the published data from the content table
						let baseData: Record<string, unknown>;
						if (existing.draftRevisionId) {
							const draftRevision = await revisionRepo.findById(existing.draftRevisionId);
							baseData = draftRevision?.data ?? existing.data;
						} else {
							baseData = existing.data;
						}

						// Include slug in the revision data if it changed
						const mergedData = { ...baseData, ...processedData };
						if (bodyWithoutRev.slug !== undefined) {
							mergedData._slug = bodyWithoutRev.slug;
						}

						if (bodyWithoutRev.skipRevision && existing.draftRevisionId) {
							// Autosave: update existing draft revision in place
							await revisionRepo.updateData(existing.draftRevisionId, mergedData);
						} else {
							// Create new draft revision
							const revision = await revisionRepo.create({
								collection,
								entryId: resolvedId,
								data: mergedData,
								authorId: bodyWithoutRev.authorId ?? undefined,
							});

							// Update entry to point to new draft (metadata only, not data columns)
							const tableName = `ec_${collection}`;
							await sql`
								UPDATE ${sql.ref(tableName)}
								SET draft_revision_id = ${revision.id},
									updated_at = ${new Date().toISOString()}
								WHERE id = ${resolvedId}
							`.execute(this.db);

							// Fire-and-forget: prune old revisions to prevent unbounded growth
							void revisionRepo.pruneOldRevisions(collection, resolvedId, 50).catch(() => {});
						}
					}
				}
			} catch {
				// Don't fail the update if revision creation fails
			}
		}

		// Update the content table:
		// - If collection uses draft revisions: only update metadata (no data fields, no slug)
		// - Otherwise: update everything as before
		const result = await handleContentUpdate(this.db, collection, resolvedId, {
			...bodyWithoutRev,
			data: usesDraftRevisions ? undefined : processedData,
			slug: usesDraftRevisions ? undefined : bodyWithoutRev.slug,
			authorId: bodyWithoutRev.authorId,
			bylines: bodyWithoutRev.bylines,
		});

		// Run afterSave hooks (fire-and-forget)
		if (result.success && result.data) {
			this.runAfterSaveHooks(contentItemToRecord(result.data.item), collection, false);
		}

		return result;
	}

	async handleContentDelete(collection: string, id: string) {
		// Run beforeDelete hooks (trusted plugins)
		if (this.hooks.hasHooks("content:beforeDelete")) {
			const { allowed } = await this.hooks.runContentBeforeDelete(id, collection);
			if (!allowed) {
				return {
					success: false,
					error: {
						code: "DELETE_BLOCKED",
						message: "Delete blocked by plugin hook",
					},
				};
			}
		}

		// Run sandboxed beforeDelete hooks
		const sandboxAllowed = await this.runSandboxedBeforeDelete(id, collection);
		if (!sandboxAllowed) {
			return {
				success: false,
				error: {
					code: "DELETE_BLOCKED",
					message: "Delete blocked by sandboxed plugin hook",
				},
			};
		}

		// Delete the content
		const result = await handleContentDelete(this.db, collection, id);

		// Run afterDelete hooks (fire-and-forget)
		if (result.success) {
			this.runAfterDeleteHooks(id, collection);
		}

		return result;
	}

	// =========================================================================
	// Trash Handlers
	// =========================================================================

	async handleContentListTrashed(
		collection: string,
		params: { cursor?: string; limit?: number } = {},
	) {
		return handleContentListTrashed(this.db, collection, params);
	}

	async handleContentRestore(collection: string, id: string) {
		return handleContentRestore(this.db, collection, id);
	}

	async handleContentPermanentDelete(collection: string, id: string) {
		return handleContentPermanentDelete(this.db, collection, id);
	}

	async handleContentCountTrashed(collection: string) {
		return handleContentCountTrashed(this.db, collection);
	}

	async handleContentDuplicate(collection: string, id: string, authorId?: string) {
		return handleContentDuplicate(this.db, collection, id, authorId);
	}

	// =========================================================================
	// Publishing & Scheduling Handlers
	// =========================================================================

	async handleContentPublish(collection: string, id: string) {
		const result = await handleContentPublish(this.db, collection, id);

		// Run afterPublish hooks (fire-and-forget)
		if (result.success && result.data) {
			this.runAfterPublishHooks(contentItemToRecord(result.data.item), collection);
		}

		return result;
	}

	async handleContentUnpublish(collection: string, id: string) {
		const result = await handleContentUnpublish(this.db, collection, id);

		// Run afterUnpublish hooks (fire-and-forget)
		if (result.success && result.data) {
			this.runAfterUnpublishHooks(contentItemToRecord(result.data.item), collection);
		}

		return result;
	}

	async handleContentSchedule(collection: string, id: string, scheduledAt: string) {
		return handleContentSchedule(this.db, collection, id, scheduledAt);
	}

	async handleContentUnschedule(collection: string, id: string) {
		return handleContentUnschedule(this.db, collection, id);
	}

	async handleContentCountScheduled(collection: string) {
		return handleContentCountScheduled(this.db, collection);
	}

	async handleContentDiscardDraft(collection: string, id: string) {
		return handleContentDiscardDraft(this.db, collection, id);
	}

	async handleContentCompare(collection: string, id: string) {
		return handleContentCompare(this.db, collection, id);
	}

	async handleContentTranslations(collection: string, id: string) {
		return handleContentTranslations(this.db, collection, id);
	}

	// =========================================================================
	// Media Handlers
	// =========================================================================

	async handleMediaList(params: { cursor?: string; limit?: number; mimeType?: string }) {
		return handleMediaList(this.db, params);
	}

	async handleMediaGet(id: string) {
		return handleMediaGet(this.db, id);
	}

	async handleMediaCreate(input: {
		filename: string;
		mimeType: string;
		size?: number;
		width?: number;
		height?: number;
		storageKey: string;
		contentHash?: string;
		blurhash?: string;
		dominantColor?: string;
	}) {
		// Run beforeUpload hooks
		let processedInput = input;
		if (this.hooks.hasHooks("media:beforeUpload")) {
			const hookResult = await this.hooks.runMediaBeforeUpload({
				name: input.filename,
				type: input.mimeType,
				size: input.size || 0,
			});
			processedInput = {
				...input,
				filename: hookResult.file.name,
				mimeType: hookResult.file.type,
				size: hookResult.file.size,
			};
		}

		// Create the media record
		const result = await handleMediaCreate(this.db, processedInput);

		// Run afterUpload hooks (fire-and-forget)
		if (result.success && this.hooks.hasHooks("media:afterUpload")) {
			const item = result.data.item;
			const mediaItem: MediaItem = {
				id: item.id,
				filename: item.filename,
				mimeType: item.mimeType,
				size: item.size,
				url: `/media/${item.id}/${item.filename}`,
				createdAt: item.createdAt,
			};
			this.hooks
				.runMediaAfterUpload(mediaItem)
				.catch((err) => console.error("EmDash afterUpload hook error:", err));
		}

		return result;
	}

	async handleMediaUpdate(
		id: string,
		input: { alt?: string; caption?: string; width?: number; height?: number },
	) {
		return handleMediaUpdate(this.db, id, input);
	}

	async handleMediaDelete(id: string) {
		return handleMediaDelete(this.db, id);
	}

	// =========================================================================
	// Revision Handlers
	// =========================================================================

	async handleRevisionList(collection: string, entryId: string, params: { limit?: number } = {}) {
		return handleRevisionList(this.db, collection, entryId, params);
	}

	async handleRevisionGet(revisionId: string) {
		return handleRevisionGet(this.db, revisionId);
	}

	async handleRevisionRestore(revisionId: string, callerUserId: string) {
		return handleRevisionRestore(this.db, revisionId, callerUserId);
	}

	// =========================================================================
	// Plugin Routes
	// =========================================================================

	/**
	 * Get route metadata for a plugin route without invoking the handler.
	 * Used by the catch-all route to decide auth before dispatch.
	 * Returns null if the plugin or route doesn't exist.
	 */
	getPluginRouteMeta(pluginId: string, path: string): RouteMeta | null {
		if (!this.isPluginEnabled(pluginId)) return null;

		const routeKey = path.replace(LEADING_SLASH_PATTERN, "");

		// Check trusted plugins first
		const trustedPlugin = this.configuredPlugins.find((p) => p.id === pluginId);
		if (trustedPlugin) {
			const route = trustedPlugin.routes[routeKey];
			if (!route) return null;
			return { public: route.public === true };
		}

		// Check sandboxed plugin route metadata cache
		const meta = sandboxedRouteMetaCache.get(pluginId);
		if (meta) {
			const routeMeta = meta.get(routeKey);
			if (routeMeta) return routeMeta;
		}

		// The "admin" route is implicitly available for any sandboxed plugin
		// that declares admin pages or widgets. This handles plugins installed
		// from bundles that predate the explicit admin route requirement.
		if (routeKey === "admin") {
			const manifestMeta = marketplaceManifestCache.get(pluginId);
			if (manifestMeta?.admin?.pages?.length || manifestMeta?.admin?.widgets?.length) {
				return { public: false };
			}
			// Also check build-time sandboxed entries
			const entry = this.sandboxedPluginEntries.find((e) => e.id === pluginId);
			if (entry?.adminPages?.length || entry?.adminWidgets?.length) {
				return { public: false };
			}
		}

		// Fallback: if the plugin exists in the sandbox cache, allow the route.
		// The sandbox runner will return an error if the route doesn't actually exist.
		if (this.findSandboxedPlugin(pluginId)) {
			return { public: false };
		}

		return null;
	}

	async handlePluginApiRoute(pluginId: string, _method: string, path: string, request: Request) {
		if (!this.isPluginEnabled(pluginId)) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Plugin not enabled: ${pluginId}` },
			};
		}

		// Check trusted (configured) plugins first — this must match the
		// resolution order in getPluginRouteMeta to avoid auth/execution mismatches.
		const trustedPlugin = this.configuredPlugins.find((p) => p.id === pluginId);
		if (trustedPlugin && this.enabledPlugins.has(trustedPlugin.id)) {
			const routeRegistry = new PluginRouteRegistry({ db: this.db });
			routeRegistry.register(trustedPlugin);

			const routeKey = path.replace(LEADING_SLASH_PATTERN, "");

			let body: unknown = undefined;
			try {
				body = await request.json();
			} catch {
				// No body or not JSON
			}

			return routeRegistry.invoke(pluginId, routeKey, { request, body });
		}

		// Check sandboxed (marketplace) plugins second
		const sandboxedPlugin = this.findSandboxedPlugin(pluginId);
		if (sandboxedPlugin) {
			return this.handleSandboxedRoute(sandboxedPlugin, path, request);
		}

		return {
			success: false,
			error: { code: "NOT_FOUND", message: `Plugin not found: ${pluginId}` },
		};
	}

	// =========================================================================
	// Sandboxed Plugin Helpers
	// =========================================================================

	private findSandboxedPlugin(pluginId: string): SandboxedPlugin | undefined {
		for (const [key, plugin] of this.sandboxedPlugins) {
			if (key.startsWith(pluginId + ":")) {
				return plugin;
			}
		}
		return undefined;
	}

	/**
	 * Normalize image/file fields in content data.
	 * Fills missing dimensions, storageKey, mimeType, and filename from providers.
	 */
	private async normalizeMediaFields(
		collection: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		let collectionInfo;
		try {
			collectionInfo = await this.schemaRegistry.getCollectionWithFields(collection);
		} catch {
			return data;
		}
		if (!collectionInfo?.fields) return data;

		const imageFields = collectionInfo.fields.filter(
			(f) => f.type === "image" || f.type === "file",
		);
		if (imageFields.length === 0) return data;

		const getProvider = (id: string) => this.getMediaProvider(id);
		const result = { ...data };

		for (const field of imageFields) {
			const value = result[field.slug];
			if (value == null) continue;

			try {
				const normalized = await normalizeMediaValue(value, getProvider);
				if (normalized) {
					result[field.slug] = normalized;
				}
			} catch {
				// Don't fail the save if normalization fails for a single field
			}
		}

		return result;
	}

	private async runSandboxedBeforeSave(
		content: Record<string, unknown>,
		collection: string,
		isNew: boolean,
	): Promise<Record<string, unknown>> {
		let result = content;

		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [id] = pluginKey.split(":");
			if (!id || !this.isPluginEnabled(id)) continue;

			try {
				const hookResult = await plugin.invokeHook("content:beforeSave", {
					content: result,
					collection,
					isNew,
				});
				if (hookResult && typeof hookResult === "object" && !Array.isArray(hookResult)) {
					// Sandbox returns unknown; convert to record by iterating own properties
					const record: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(hookResult)) {
						record[k] = v;
					}
					result = record;
				}
			} catch (error) {
				console.error(`EmDash: Sandboxed plugin ${id} beforeSave hook error:`, error);
			}
		}

		return result;
	}

	private async runSandboxedBeforeDelete(id: string, collection: string): Promise<boolean> {
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [pluginId] = pluginKey.split(":");
			if (!pluginId || !this.isPluginEnabled(pluginId)) continue;

			try {
				const result = await plugin.invokeHook("content:beforeDelete", {
					id,
					collection,
				});
				if (result === false) {
					return false;
				}
			} catch (error) {
				console.error(`EmDash: Sandboxed plugin ${pluginId} beforeDelete hook error:`, error);
			}
		}

		return true;
	}

	private runAfterSaveHooks(
		content: Record<string, unknown>,
		collection: string,
		isNew: boolean,
	): void {
		// Trusted plugins
		if (this.hooks.hasHooks("content:afterSave")) {
			this.hooks
				.runContentAfterSave(content, collection, isNew)
				.catch((err) => console.error("EmDash afterSave hook error:", err));
		}

		// Sandboxed plugins
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [id] = pluginKey.split(":");
			if (!id || !this.isPluginEnabled(id)) continue;

			plugin
				.invokeHook("content:afterSave", { content, collection, isNew })
				.catch((err) => console.error(`EmDash: Sandboxed plugin ${id} afterSave error:`, err));
		}
	}

	private runAfterDeleteHooks(id: string, collection: string): void {
		// Trusted plugins
		if (this.hooks.hasHooks("content:afterDelete")) {
			this.hooks
				.runContentAfterDelete(id, collection)
				.catch((err) => console.error("EmDash afterDelete hook error:", err));
		}

		// Sandboxed plugins
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [pluginId] = pluginKey.split(":");
			if (!pluginId || !this.isPluginEnabled(pluginId)) continue;

			plugin
				.invokeHook("content:afterDelete", { id, collection })
				.catch((err) =>
					console.error(`EmDash: Sandboxed plugin ${pluginId} afterDelete error:`, err),
				);
		}
	}

	private runAfterPublishHooks(content: Record<string, unknown>, collection: string): void {
		// Trusted plugins
		if (this.hooks.hasHooks("content:afterPublish")) {
			this.hooks
				.runContentAfterPublish(content, collection)
				.catch((err) => console.error("EmDash afterPublish hook error:", err));
		}

		// Sandboxed plugins
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [pluginId] = pluginKey.split(":");
			if (!pluginId || !this.isPluginEnabled(pluginId)) continue;

			plugin
				.invokeHook("content:afterPublish", { content, collection })
				.catch((err) =>
					console.error(`EmDash: Sandboxed plugin ${pluginId} afterPublish error:`, err),
				);
		}
	}

	private runAfterUnpublishHooks(content: Record<string, unknown>, collection: string): void {
		// Trusted plugins
		if (this.hooks.hasHooks("content:afterUnpublish")) {
			this.hooks
				.runContentAfterUnpublish(content, collection)
				.catch((err) => console.error("EmDash afterUnpublish hook error:", err));
		}

		// Sandboxed plugins
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [pluginId] = pluginKey.split(":");
			if (!pluginId || !this.isPluginEnabled(pluginId)) continue;

			plugin
				.invokeHook("content:afterUnpublish", { content, collection })
				.catch((err) =>
					console.error(`EmDash: Sandboxed plugin ${pluginId} afterUnpublish error:`, err),
				);
		}
	}

	private async handleSandboxedRoute(
		plugin: SandboxedPlugin,
		path: string,
		request: Request,
	): Promise<{
		success: boolean;
		data?: unknown;
		error?: { code: string; message: string };
	}> {
		const routeName = path.replace(LEADING_SLASH_PATTERN, "");

		let body: unknown = undefined;
		try {
			body = await request.json();
		} catch {
			// No body or not JSON
		}

		try {
			const headers = sanitizeHeadersForSandbox(request.headers);
			const meta = extractRequestMeta(request);
			const result = await plugin.invokeRoute(routeName, body, {
				url: request.url,
				method: request.method,
				headers,
				meta,
			});
			return { success: true, data: result };
		} catch (error) {
			console.error(`EmDash: Sandboxed plugin route error:`, error);
			return {
				success: false,
				error: {
					code: "ROUTE_ERROR",
					message: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	// =========================================================================
	// Public Page Contributions
	// =========================================================================

	/**
	 * Cache for page contributions. Uses a WeakMap keyed on the PublicPageContext
	 * object so results are collected once per page context per request, even when
	 * multiple render components (EmDashHead, EmDashBodyStart, EmDashBodyEnd)
	 * request contributions from the same page.
	 */
	private pageContributionCache = new WeakMap<PublicPageContext, Promise<PageContributions>>();

	/**
	 * Collect all page contributions (metadata + fragments) in a single pass.
	 * Results are cached by page context object identity.
	 */
	async collectPageContributions(page: PublicPageContext): Promise<PageContributions> {
		const cached = this.pageContributionCache.get(page);
		if (cached) return cached;

		const promise = this.doCollectPageContributions(page);
		this.pageContributionCache.set(page, promise);
		return promise;
	}

	private async doCollectPageContributions(page: PublicPageContext): Promise<PageContributions> {
		const metadata: PageMetadataContribution[] = [];
		const fragments: PageFragmentContribution[] = [];

		// Trusted plugins via HookPipeline — both metadata and fragments
		if (this.hooks.hasHooks("page:metadata")) {
			const results = await this.hooks.runPageMetadata({ page });
			for (const r of results) {
				metadata.push(...r.contributions);
			}
		}

		if (this.hooks.hasHooks("page:fragments")) {
			const results = await this.hooks.runPageFragments({ page });
			for (const r of results) {
				fragments.push(...r.contributions);
			}
		}

		// Sandboxed plugins — metadata only, never fragments
		for (const [pluginKey, plugin] of this.sandboxedPlugins) {
			const [id] = pluginKey.split(":");
			if (!id || !this.isPluginEnabled(id)) continue;

			try {
				const result = await plugin.invokeHook("page:metadata", { page });
				if (result != null) {
					const items = Array.isArray(result) ? result : [result];
					for (const item of items) {
						if (isValidMetadataContribution(item)) {
							metadata.push(item);
						}
					}
				}
			} catch (error) {
				console.error(`EmDash: Sandboxed plugin ${id} page:metadata error:`, error);
			}
		}

		return { metadata, fragments };
	}

	/**
	 * Collect page metadata contributions from trusted and sandboxed plugins.
	 * Delegates to the single-pass collector and returns the metadata portion.
	 */
	async collectPageMetadata(page: PublicPageContext): Promise<PageMetadataContribution[]> {
		const { metadata } = await this.collectPageContributions(page);
		return metadata;
	}

	/**
	 * Collect page fragment contributions from trusted plugins only.
	 * Delegates to the single-pass collector and returns the fragments portion.
	 */
	async collectPageFragments(page: PublicPageContext): Promise<PageFragmentContribution[]> {
		const { fragments } = await this.collectPageContributions(page);
		return fragments;
	}

	private isPluginEnabled(pluginId: string): boolean {
		const status = this.pluginStates.get(pluginId);
		return status === undefined || status === "active";
	}
}
