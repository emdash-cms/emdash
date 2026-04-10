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

import type {
	SandboxRunner,
	SandboxedPlugin,
	SandboxEmailSendCallback,
	SandboxOptions,
	SerializedRequest,
} from "emdash";
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

	constructor(options: SandboxOptions) {
		this.options = options;
		this.siteInfo = options.siteInfo;
		this.emailSendCallback = options.emailSend ?? null;
	}

	isAvailable(): boolean {
		try {
			require.resolve("miniflare");
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

		for (const [pluginId, { manifest }] of this.plugins) {
			const bridgeHandler = createBridgeHandler({
				pluginId: manifest.id,
				version: manifest.version || "0.0.0",
				capabilities: manifest.capabilities || [],
				allowedHosts: manifest.allowedHosts || [],
				storageCollections: Object.keys(manifest.storage || {}),
				db: this.options.db,
				emailSend: () => this.emailSendCallback,
			});

			const wrapperCode = generatePluginWrapper(manifest, {
				site: this.siteInfo,
				backingServiceUrl: "http://bridge",
				authToken: "dev-mode",
			});

			// outboundService intercepts all fetch() calls from this worker.
			// Calls to http://bridge/... go to the Node bridge handler.
			// Other calls pass through for network:fetch.
			workerConfigs.push({
				name: pluginId.replace(SAFE_ID_RE, "_"),
				modules: true,
				script: wrapperCode,
				outboundService: async (request: Request) => {
					const url = new URL(request.url);
					if (url.hostname === "bridge") {
						return bridgeHandler(request);
					}
					return globalThis.fetch(request);
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
		const res = await this.runner.dispatchToPlugin(this.id, `http://plugin/hook/${hookName}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ event }),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Plugin ${this.id} hook ${hookName} failed: ${text}`);
		}
		const result = (await res.json()) as { value: unknown };
		return result.value;
	}

	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<unknown> {
		if (!this.runner.isHealthy()) {
			throw new Error(`Dev sandbox unavailable for ${this.id}`);
		}
		const res = await this.runner.dispatchToPlugin(this.id, `http://plugin/route/${routeName}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input, request }),
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Plugin ${this.id} route ${routeName} failed: ${text}`);
		}
		return res.json();
	}

	async terminate(): Promise<void> {
		// Miniflare manages lifecycle
	}
}
