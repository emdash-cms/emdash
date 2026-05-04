/**
 * Cloudflare Sandbox Runner
 *
 * Uses Worker Loader to run plugins in isolated V8 isolates.
 * Plugins communicate with the host via a BRIDGE service binding
 * that enforces capabilities and scopes operations.
 *
 * This module imports directly from cloudflare:workers to access
 * the LOADER binding and PluginBridge export. It's only loaded
 * when the user configures `sandboxRunner: "@emdash-cms/cloudflare/sandbox"`.
 *
 */

import { env, exports } from "cloudflare:workers";
import {
	normalizeCapabilities,
	type SandboxRunner,
	type SandboxedPlugin,
	type SandboxEmailSendCallback,
	type SandboxOptions,
	type SandboxRunnerFactory,
	type SerializedRequest,
	type PluginManifest,
} from "emdash";

import { setEmailSendCallback } from "./bridge.js";
import type { WorkerLoader, WorkerStub, PluginBridgeBinding, WorkerLoaderLimits } from "./types.js";
import { generatePluginWrapper } from "./wrapper.js";

const EMDASH_SHIM = "export const definePlugin = (d) => d;\n";

/**
 * Default resource limits for sandboxed plugins.
 *
 * cpuMs and subrequests are enforced by Worker Loader at the V8 isolate level.
 * wallTimeMs is enforced by the runner via Promise.race.
 * memoryMb is declared for API compatibility but NOT currently enforced —
 * Worker Loader doesn't expose a memory limit option. V8 isolates have a
 * platform-level memory ceiling (~128MB) but it's not configurable per-worker.
 */
const DEFAULT_LIMITS = {
	cpuMs: 50,
	memoryMb: 128,
	subrequests: 10,
	wallTimeMs: 30_000,
} as const;

export interface PluginBridgeProps {
	pluginId: string;
	pluginVersion: string;
	capabilities: string[];
	allowedHosts: string[];
	storageCollections: string[];
	storageConfig?: Record<
		string,
		{ indexes?: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>;
}

/**
 * Get the Worker Loader binding from env
 */
function getLoader(): WorkerLoader | null {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker Loader binding accessed from untyped env object
	return (env as Record<string, unknown>).LOADER as WorkerLoader | null;
}

/**
 * Get the PluginBridge from exports (loopback binding)
 */
function getPluginBridge(): ((opts: { props: PluginBridgeProps }) => PluginBridgeBinding) | null {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- PluginBridge accessed from untyped cloudflare:workers exports
	return (exports as Record<string, unknown>).PluginBridge as
		| ((opts: { props: PluginBridgeProps }) => PluginBridgeBinding)
		| null;
}

/**
 * Resolved resource limits with defaults applied.
 */
interface ResolvedLimits {
	cpuMs: number;
	memoryMb: number;
	subrequests: number;
	wallTimeMs: number;
}

/**
 * Resolve resource limits by merging user-provided overrides with defaults.
 */
function resolveLimits(limits?: SandboxOptions["limits"]): ResolvedLimits {
	return {
		cpuMs: limits?.cpuMs ?? DEFAULT_LIMITS.cpuMs,
		memoryMb: limits?.memoryMb ?? DEFAULT_LIMITS.memoryMb,
		subrequests: limits?.subrequests ?? DEFAULT_LIMITS.subrequests,
		wallTimeMs: limits?.wallTimeMs ?? DEFAULT_LIMITS.wallTimeMs,
	};
}

/**
 * Cloudflare sandbox runner using Worker Loader.
 */
export class CloudflareSandboxRunner implements SandboxRunner {
	private plugins = new Map<string, CloudflareSandboxedPlugin>();
	private options: SandboxOptions;
	private resolvedLimits: ResolvedLimits;
	private siteInfo?: { name: string; url: string; locale: string };

	constructor(options: SandboxOptions) {
		this.options = options;
		this.resolvedLimits = resolveLimits(options.limits);
		this.siteInfo = options.siteInfo;

		// Wire email send callback if provided at construction time
		setEmailSendCallback(options.emailSend ?? null);
	}

	/**
	 * Set the email send callback for sandboxed plugins.
	 * Called after the EmailPipeline is created, since the pipeline
	 * doesn't exist when the sandbox runner is constructed.
	 */
	setEmailSend(callback: SandboxEmailSendCallback | null): void {
		setEmailSendCallback(callback);
	}

	/**
	 * Check if Worker Loader is available.
	 */
	isAvailable(): boolean {
		return !!getLoader() && !!getPluginBridge();
	}

	/**
	 * Worker Loader runs in-process, always healthy if available.
	 */
	isHealthy(): boolean {
		return this.isAvailable();
	}

	/**
	 * Load a sandboxed plugin.
	 *
	 * @param manifest - Plugin manifest with capabilities and storage declarations
	 * @param code - The bundled plugin JavaScript code
	 */
	async load(manifest: PluginManifest, code: string): Promise<SandboxedPlugin> {
		const pluginId = `${manifest.id}:${manifest.version}`;

		// Return cached plugin if available
		const existing = this.plugins.get(pluginId);
		if (existing) return existing;

		const loader = getLoader();
		const pluginBridge = getPluginBridge();

		if (!loader) {
			throw new Error(
				"Worker Loader not available. Add worker_loaders binding to wrangler config.",
			);
		}

		if (!pluginBridge) {
			throw new Error(
				"PluginBridge not available. Export PluginBridge from your worker entrypoint.",
			);
		}

		const plugin = new CloudflareSandboxedPlugin(
			manifest,
			code,
			loader,
			pluginBridge,
			this.resolvedLimits,
			this.siteInfo,
		);

		this.plugins.set(pluginId, plugin);
		return plugin;
	}

	/**
	 * Terminate all loaded plugins.
	 */
	async terminateAll(): Promise<void> {
		for (const plugin of this.plugins.values()) {
			await plugin.terminate();
		}
		this.plugins.clear();
	}
}

/**
 * A plugin running in a Worker Loader isolate.
 *
 * IMPORTANT: Worker stubs and bridge bindings are tied to request context.
 * We must create fresh stubs for each invocation to avoid I/O isolation errors:
 * "Cannot perform I/O on behalf of a different request"
 */
class CloudflareSandboxedPlugin implements SandboxedPlugin {
	readonly id: string;
	readonly manifest: PluginManifest;
	private loader: WorkerLoader;
	private createBridge: (opts: { props: PluginBridgeProps }) => PluginBridgeBinding;
	private code: string;
	private wrapperCode: string | null = null;
	private limits: ResolvedLimits;
	private siteInfo?: { name: string; url: string; locale: string };

	constructor(
		manifest: PluginManifest,
		code: string,
		loader: WorkerLoader,
		createBridge: (opts: { props: PluginBridgeProps }) => PluginBridgeBinding,
		limits: ResolvedLimits,
		siteInfo?: { name: string; url: string; locale: string },
	) {
		this.id = `${manifest.id}:${manifest.version}`;
		this.manifest = manifest;
		this.code = code;
		this.loader = loader;
		this.createBridge = createBridge;
		this.limits = limits;
		this.siteInfo = siteInfo;
	}

	/**
	 * Create a fresh worker stub for the current request.
	 *
	 * Worker Loader stubs contain bindings (like BRIDGE) that are tied to the
	 * request context in which they were created. Reusing stubs across requests
	 * causes "Cannot perform I/O on behalf of a different request" errors.
	 *
	 * The Worker Loader internally caches the V8 isolate, so we only pay the
	 * cost of creating the bridge binding and stub wrapper per request.
	 */
	private createWorker(): WorkerStub {
		// Cache the wrapper code (CPU-bound, no I/O context issues)
		if (!this.wrapperCode) {
			this.wrapperCode = generatePluginWrapper(this.manifest, {
				site: this.siteInfo,
			});
		}

		// Create fresh bridge binding for THIS request.
		//
		// Capabilities are normalized to canonical names here so the bridge
		// only ever sees the current vocabulary. Manifests installed before
		// the rename (or sites still using the legacy alias layer) keep
		// working — `normalizeCapabilities` rewrites legacy names like
		// `read:content` → `content:read` and `network:fetch` → `network:request`.
		const bridgeBinding = this.createBridge({
			props: {
				pluginId: this.manifest.id,
				pluginVersion: this.manifest.version || "0.0.0",
				capabilities: normalizeCapabilities(this.manifest.capabilities || []),
				allowedHosts: this.manifest.allowedHosts || [],
				storageCollections: Object.keys(this.manifest.storage || {}),
				storageConfig: this.manifest.storage as
					| Record<
							string,
							{
								indexes?: Array<string | string[]>;
								uniqueIndexes?: Array<string | string[]>;
							}
					  >
					| undefined,
			},
		});

		// Build Worker Loader limits from resolved resource limits
		const loaderLimits: WorkerLoaderLimits = {
			cpuMs: this.limits.cpuMs,
			subRequests: this.limits.subrequests,
		};

		// Get a fresh stub with the new bridge binding.
		// Worker Loader caches the isolate but the stub/bindings are per-call.
		return this.loader.get(this.id, () => ({
			compatibilityDate: "2026-04-01",
			mainModule: "plugin.js",
			modules: {
				"plugin.js": { js: this.wrapperCode! },
				"sandbox-plugin.js": { js: this.code },
				emdash: { js: EMDASH_SHIM },
			},
			// Block direct network access - plugins must use ctx.http via bridge
			globalOutbound: null,
			// Enforce resource limits at the V8 isolate level
			limits: loaderLimits,
			env: {
				// Plugin metadata
				PLUGIN_ID: this.manifest.id,
				PLUGIN_VERSION: this.manifest.version || "0.0.0",
				// Bridge binding for all host operations
				BRIDGE: bridgeBinding,
			},
		}));
	}

	/**
	 * Run a function with wall-time enforcement.
	 *
	 * CPU limits and subrequest limits are enforced by the Worker Loader
	 * at the V8 isolate level. Wall-time is enforced here because Worker
	 * Loader doesn't expose a wall-time limit — a plugin could stall
	 * indefinitely waiting on network I/O.
	 */
	private async withWallTimeLimit<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		const wallTimeMs = this.limits.wallTimeMs;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new Error(
						`Plugin ${this.manifest.id} exceeded wall-time limit of ${wallTimeMs}ms during ${operation}`,
					),
				);
			}, wallTimeMs);
		});

		try {
			return await Promise.race([fn(), timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Invoke a hook in the sandboxed plugin.
	 *
	 * CPU and subrequest limits are enforced by Worker Loader.
	 * Wall-time is enforced here.
	 */
	async invokeHook(hookName: string, event: unknown): Promise<unknown> {
		return this.withWallTimeLimit(`hook:${hookName}`, () => {
			const worker = this.createWorker();
			const entrypoint = worker.getEntrypoint<PluginEntrypoint>("default");
			return entrypoint.invokeHook(hookName, event);
		});
	}

	/**
	 * Invoke an API route in the sandboxed plugin.
	 *
	 * CPU and subrequest limits are enforced by Worker Loader.
	 * Wall-time is enforced here.
	 */
	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<unknown> {
		return this.withWallTimeLimit(`route:${routeName}`, () => {
			const worker = this.createWorker();
			const entrypoint = worker.getEntrypoint<PluginEntrypoint>("default");
			return entrypoint.invokeRoute(routeName, input, request);
		});
	}

	/**
	 * Terminate the sandboxed plugin.
	 */
	async terminate(): Promise<void> {
		// Worker Loader manages isolate lifecycle - nothing to do here
		this.wrapperCode = null;
	}
}

/**
 * The RPC interface exposed by the plugin wrapper.
 */
interface PluginEntrypoint {
	invokeHook(hookName: string, event: unknown): Promise<unknown>;
	invokeRoute(routeName: string, input: unknown, request: SerializedRequest): Promise<unknown>;
}

/**
 * Factory function for creating the Cloudflare sandbox runner.
 *
 * Matches the SandboxRunnerFactory signature. The LOADER and PluginBridge
 * are obtained internally from cloudflare:workers imports.
 */
export const createSandboxRunner: SandboxRunnerFactory = (options) => {
	return new CloudflareSandboxRunner(options);
};
