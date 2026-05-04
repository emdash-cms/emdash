/**
 * Miniflare Dev Runner
 *
 * Uses miniflare for plugin sandboxing during development.
 * Provides the same SandboxRunner interface as WorkerdSandboxRunner
 * but uses miniflare's serviceBindings-as-functions pattern instead
 * of raw workerd + capnp + HTTP backing service.
 *
 * Advantages over raw workerd in dev:
 * - No HTTP backing service needed (bridge calls are Node functions)
 * - No capnp config generation
 * - No child process management
 * - Faster startup
 */

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

import type {
	SandboxRunner,
	SandboxedPlugin,
	SandboxEmailSendCallback,
	SandboxOptions,
	SerializedRequest,
} from "emdash";

const DEFAULT_WALL_TIME_MS = 30_000;
import type { PluginManifest } from "emdash";

import { createBridgeHandler } from "./bridge-handler.js";
import { generatePluginWrapper } from "./wrapper.js";

const SAFE_ID_RE = /[^a-z0-9_-]/gi;

/**
 * Miniflare-based sandbox runner for development.
 */
export class MiniflareDevRunner implements SandboxRunner {
	private options: SandboxOptions;
	private siteInfo?: { name: string; url: string; locale: string };
	private emailSendCallback: SandboxEmailSendCallback | null = null;

	/** Miniflare instance (lazily created) */
	private mf: InstanceType<typeof import("miniflare").Miniflare> | null = null;

	/** Loaded plugins */
	private plugins = new Map<string, { manifest: PluginManifest; code: string }>();

	/** Whether miniflare is running */
	private running = false;

	/**
	 * Per-startup token sent on every hook/route invocation. Plugins reject
	 * requests without this token. In dev mode the plugin worker is only
	 * reachable through miniflare's dispatchFetch, but we still wire the
	 * token for consistency with production and so the wrapper template
	 * is identical in both modes.
	 */
	private devInvokeToken: string;

	constructor(options: SandboxOptions) {
		this.options = options;
		this.siteInfo = options.siteInfo;
		this.emailSendCallback = options.emailSend ?? null;
		this.devInvokeToken = randomBytes(32).toString("hex");
	}

	get wallTimeMs(): number {
		return this.options.limits?.wallTimeMs ?? DEFAULT_WALL_TIME_MS;
	}

	/** Get the per-startup invoke token (sent on hook/route requests to plugins) */
	get invokeAuthToken() {
		return this.devInvokeToken;
	}

	isAvailable(): boolean {
		try {
			const esmRequire = createRequire(import.meta.url);
			esmRequire.resolve("miniflare");
			return true;
		} catch {
			return false;
		}
	}

	isHealthy(): boolean {
		return this.running;
	}

	setEmailSend(callback: SandboxEmailSendCallback | null): void {
		this.emailSendCallback = callback;
	}

	async load(manifest: PluginManifest, code: string): Promise<SandboxedPlugin> {
		const pluginId = `${manifest.id}:${manifest.version}`;
		this.plugins.set(pluginId, { manifest, code });

		// Rebuild miniflare with all plugins
		await this.rebuild();

		return new MiniflareDevPlugin(pluginId, manifest, this);
	}

	async terminateAll(): Promise<void> {
		if (this.mf) {
			await this.mf.dispose();
			this.mf = null;
		}
		this.plugins.clear();
		this.running = false;
	}

	/**
	 * Unload a single plugin and rebuild miniflare without it.
	 * Called from MiniflareDevPlugin.terminate() so marketplace
	 * update/uninstall flows actually drop the old plugin from
	 * the dev sandbox instead of leaving stale entries.
	 */
	async unloadPlugin(pluginId: string): Promise<void> {
		if (this.plugins.delete(pluginId)) {
			await this.rebuild();
		}
	}

	/**
	 * Rebuild miniflare with current plugin configuration.
	 * Called on each plugin load/unload.
	 */
	private async rebuild(): Promise<void> {
		if (this.mf) {
			await this.mf.dispose();
			this.mf = null;
		}

		if (this.plugins.size === 0) {
			this.running = false;
			return;
		}

		const { Miniflare } = await import("miniflare");

		// Build worker configs with outboundService to intercept bridge calls.
		// The wrapper code does fetch("http://bridge/method", ...).
		// outboundService intercepts all outbound fetches and routes bridge
		// calls to the Node handler function.
		const workerConfigs = [];

		for (const [pluginId, { manifest, code }] of this.plugins) {
			const bridgeHandler = createBridgeHandler({
				pluginId: manifest.id,
				version: manifest.version || "0.0.0",
				capabilities: manifest.capabilities || [],
				allowedHosts: manifest.allowedHosts || [],
				storageCollections: Object.keys(manifest.storage || {}),
				storageConfig: manifest.storage as
					| Record<string, { indexes?: Array<string | string[]> }>
					| undefined,
				db: this.options.db,
				emailSend: () => this.emailSendCallback,
				storage: this.options.mediaStorage,
			});

			const wrapperCode = generatePluginWrapper(manifest, {
				site: this.siteInfo,
				backingServiceUrl: "http://bridge",
				authToken: "dev-mode",
				invokeToken: this.devInvokeToken,
			});

			// outboundService intercepts all fetch() calls from this worker.
			// Calls to http://bridge/... go to the Node bridge handler.
			// Other calls pass through for network:fetch.
			workerConfigs.push({
				name: pluginId.replace(SAFE_ID_RE, "_"),
				// The wrapper imports "sandbox-plugin.js", so we provide both
				// the wrapper as the main module and the plugin code as a
				// named module that the wrapper can import.
				modulesRoot: "/",
				modules: [
					{ type: "ESModule" as const, path: "worker.js", contents: wrapperCode },
					{ type: "ESModule" as const, path: "sandbox-plugin.js", contents: code },
				],
				outboundService: async (request: Request) => {
					const url = new URL(request.url);
					// Only allow bridge calls. Any other outbound fetch is blocked
					// to enforce that all network access goes through ctx.http.fetch
					// (which routes via the bridge with capability + host validation).
					// Without this, plugins could bypass network:fetch / allowedHosts
					// by calling plain fetch() directly.
					if (url.hostname === "bridge") {
						return bridgeHandler(request);
					}
					return new Response(
						`Direct fetch() blocked in sandbox. Plugin "${manifest.id}" must use ctx.http.fetch() (requires network:fetch capability).`,
						{ status: 403 },
					);
				},
			});
		}

		this.mf = new Miniflare({ workers: workerConfigs });
		this.running = true;
	}

	/**
	 * Dispatch a fetch to a specific plugin worker in miniflare.
	 */
	async dispatchToPlugin(pluginId: string, url: string, init?: RequestInit): Promise<Response> {
		if (!this.mf) {
			throw new Error(`Miniflare not running, cannot dispatch to ${pluginId}`);
		}
		const workerName = pluginId.replace(SAFE_ID_RE, "_");
		const worker = await this.mf.getWorker(workerName);
		return worker.fetch(url, init);
	}
}

/**
 * A plugin running in a miniflare dev isolate.
 */
class MiniflareDevPlugin implements SandboxedPlugin {
	readonly id: string;
	private manifest: PluginManifest;
	private runner: MiniflareDevRunner;

	constructor(id: string, manifest: PluginManifest, runner: MiniflareDevRunner) {
		this.id = id;
		this.manifest = manifest;
		this.runner = runner;
	}

	async invokeHook(hookName: string, event: unknown): Promise<unknown> {
		if (!this.runner.isHealthy()) {
			throw new Error(`Dev sandbox unavailable for ${this.id}`);
		}
		return this.withWallTimeLimit(`hook:${hookName}`, async () => {
			const res = await this.runner.dispatchToPlugin(this.id, `http://plugin/hook/${hookName}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.runner.invokeAuthToken}`,
				},
				body: JSON.stringify({ event }),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Plugin ${this.id} hook ${hookName} failed: ${text}`);
			}
			const result = (await res.json()) as { value: unknown };
			return result.value;
		});
	}

	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<unknown> {
		if (!this.runner.isHealthy()) {
			throw new Error(`Dev sandbox unavailable for ${this.id}`);
		}
		return this.withWallTimeLimit(`route:${routeName}`, async () => {
			const res = await this.runner.dispatchToPlugin(this.id, `http://plugin/route/${routeName}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.runner.invokeAuthToken}`,
				},
				body: JSON.stringify({ input, request }),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Plugin ${this.id} route ${routeName} failed: ${text}`);
			}
			return res.json();
		});
	}

	private async withWallTimeLimit<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		const wallTimeMs = this.runner.wallTimeMs;
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

	async terminate(): Promise<void> {
		// Drop this plugin from the runner so marketplace update/uninstall
		// actually removes it from the dev sandbox.
		await this.runner.unloadPlugin(this.id);
	}
}
