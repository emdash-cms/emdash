/**
 * Workerd Sandbox Runner
 *
 * Implements the SandboxRunner interface for Node.js deployments using
 * workerd as a sidecar process. Plugins run in isolated V8 isolates
 * with capability-scoped access to EmDash APIs.
 *
 * Architecture:
 * - Node spawns workerd with a generated capnp config
 * - Each plugin is a nanoservice with its own internal port
 * - Plugins communicate with Node via a backing service HTTP server
 * - Node invokes plugin hooks/routes via HTTP to the plugin's port
 * - Plugins call back to Node for content/media/KV/email operations
 *
 * The backing service HTTP server runs in the Node process and handles
 * authenticated requests from plugins. Each plugin receives a unique
 * auth token that encodes its ID and capabilities.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	SandboxRunner,
	SandboxedPlugin,
	SandboxEmailSendCallback,
	SandboxOptions,
	SandboxRunnerFactory,
	SerializedRequest,
} from "emdash";
import type { PluginManifest } from "emdash";
// @ts-ignore -- SandboxUnavailableError is a class export, not type-only
import { SandboxUnavailableError } from "emdash";

import { createBackingServiceHandler } from "./backing-service.js";
import { generateCapnpConfig } from "./capnp.js";

const SAFE_ID_RE = /[^a-z0-9_-]/gi;
import { generatePluginWrapper } from "./wrapper.js";

/**
 * Default resource limits for sandboxed plugins.
 * Matches Cloudflare production limits.
 */
const DEFAULT_LIMITS = {
	cpuMs: 50,
	memoryMb: 128,
	subrequests: 10,
	wallTimeMs: 30_000,
} as const;

/**
 * Resolved resource limits with defaults applied.
 */
interface ResolvedLimits {
	cpuMs: number;
	memoryMb: number;
	subrequests: number;
	wallTimeMs: number;
}

function resolveLimits(limits?: SandboxOptions["limits"]): ResolvedLimits {
	return {
		cpuMs: limits?.cpuMs ?? DEFAULT_LIMITS.cpuMs,
		memoryMb: limits?.memoryMb ?? DEFAULT_LIMITS.memoryMb,
		subrequests: limits?.subrequests ?? DEFAULT_LIMITS.subrequests,
		wallTimeMs: limits?.wallTimeMs ?? DEFAULT_LIMITS.wallTimeMs,
	};
}

/**
 * State for a loaded plugin in the workerd process.
 */
interface LoadedPlugin {
	manifest: PluginManifest;
	code: string;
	/** Port the plugin's nanoservice listens on inside workerd */
	port: number;
	/** Auth token for this plugin's backing service requests */
	token: string;
}

/**
 * Workerd sandbox runner for Node.js deployments.
 *
 * Manages a workerd child process and a backing service HTTP server.
 * Plugins are added/removed by regenerating the capnp config and
 * restarting workerd (millisecond cold start).
 */
export class WorkerdSandboxRunner implements SandboxRunner {
	private options: SandboxOptions;
	private limits: ResolvedLimits;
	private siteInfo?: { name: string; url: string; locale: string };

	/** Loaded plugins indexed by pluginId (manifest.id:manifest.version) */
	private plugins = new Map<string, LoadedPlugin>();

	/** Backing service HTTP server (runs in Node) */
	private backingServer: Server | null = null;
	private backingPort = 0;

	/** workerd child process */
	private workerdProcess: ChildProcess | null = null;

	/** Master secret for generating per-plugin auth tokens */
	private masterSecret = randomBytes(32).toString("hex");

	/** Temporary directory for capnp config and plugin code files */
	private configDir: string | null = null;

	/** Email send callback, wired from EmailPipeline */
	private emailSendCallback: SandboxEmailSendCallback | null = null;

	/** Epoch counter, incremented on each workerd restart */
	private epoch = 0;

	/** Next available port for plugin nanoservices */
	private nextPluginPort = 18788;

	/** Whether workerd is currently healthy */
	private healthy = false;

	/** Crash restart state */
	private crashCount = 0;
	private crashWindowStart = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private shuttingDown = false;

	/** SIGTERM handler for clean shutdown */
	private sigHandler: (() => void) | null = null;

	constructor(options: SandboxOptions) {
		this.options = options;
		this.limits = resolveLimits(options.limits);
		this.siteInfo = options.siteInfo;
		this.emailSendCallback = options.emailSend ?? null;

		// Forward SIGTERM to workerd child for clean shutdown
		this.sigHandler = () => {
			this.shuttingDown = true;
			void this.terminateAll();
		};
		process.on("SIGTERM", this.sigHandler);
	}

	/**
	 * Check if workerd is available on this system.
	 */
	isAvailable(): boolean {
		try {
			// Check if workerd binary exists
			const { execSync } = require("node:child_process") as typeof import("node:child_process");
			execSync("npx workerd --version", { stdio: "ignore", timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if the workerd process is healthy.
	 */
	isHealthy(): boolean {
		return this.healthy && this.workerdProcess !== null && !this.workerdProcess.killed;
	}

	/**
	 * Set the email send callback for sandboxed plugins.
	 */
	setEmailSend(callback: SandboxEmailSendCallback | null): void {
		this.emailSendCallback = callback;
	}

	/**
	 * Load a sandboxed plugin.
	 *
	 * Adds the plugin to the configuration and restarts workerd
	 * to pick up the new nanoservice.
	 */
	async load(manifest: PluginManifest, code: string): Promise<SandboxedPlugin> {
		const pluginId = `${manifest.id}:${manifest.version}`;

		// Return cached plugin if already loaded
		const existing = this.plugins.get(pluginId);
		if (existing) {
			return new WorkerdSandboxedPlugin(pluginId, manifest, existing.port, this.limits, this);
		}

		// Assign port and generate auth token
		const port = this.nextPluginPort++;
		const token = this.generatePluginToken(manifest);

		this.plugins.set(pluginId, { manifest, code, port, token });

		// Restart workerd with updated config
		await this.restart();

		return new WorkerdSandboxedPlugin(pluginId, manifest, port, this.limits, this);
	}

	/**
	 * Terminate all loaded plugins and shut down workerd.
	 */
	async terminateAll(): Promise<void> {
		this.shuttingDown = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		if (this.sigHandler) {
			process.removeListener("SIGTERM", this.sigHandler);
			this.sigHandler = null;
		}
		this.plugins.clear();
		await this.stopWorkerd();
		await this.stopBackingServer();
		if (this.configDir) {
			await rm(this.configDir, { recursive: true, force: true }).catch(() => {});
			this.configDir = null;
		}
	}

	/**
	 * Schedule a restart with exponential backoff.
	 * Backoff: 1s, 2s, 4s, cap at 30s.
	 * Gives up after 5 failures within 60 seconds.
	 */
	private scheduleRestart(): void {
		if (this.shuttingDown || this.plugins.size === 0) return;

		const now = Date.now();

		// Reset crash window if it's been more than 60 seconds
		if (now - this.crashWindowStart > 60_000) {
			this.crashCount = 0;
			this.crashWindowStart = now;
		}

		this.crashCount++;

		if (this.crashCount > 5) {
			console.error(
				"[emdash:workerd] workerd crashed 5 times in 60 seconds, giving up. " +
					"Plugins will run unsandboxed. Restart the server to retry.",
			);
			return;
		}

		// Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
		const delayMs = Math.min(1000 * 2 ** (this.crashCount - 1), 30_000);
		console.warn(`[emdash:workerd] restarting in ${delayMs}ms (attempt ${this.crashCount}/5)`);

		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.restart().catch((err) => {
				console.error("[emdash:workerd] restart failed:", err);
				this.scheduleRestart();
			});
		}, delayMs);
	}

	/**
	 * Generate a per-plugin auth token.
	 * Encodes pluginId and capabilities for server-side validation.
	 */
	private generatePluginToken(manifest: PluginManifest): string {
		const payload = JSON.stringify({
			pluginId: manifest.id,
			version: manifest.version,
			capabilities: manifest.capabilities || [],
			allowedHosts: manifest.allowedHosts || [],
			storageCollections: Object.keys(manifest.storage || {}),
		});
		// Simple HMAC-like token: base64(payload).base64(hmac)
		const payloadB64 = Buffer.from(payload).toString("base64url");
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
		const hmac = createHmac("sha256", this.masterSecret).update(payload).digest("base64url");
		return `${payloadB64}.${hmac}`;
	}

	/**
	 * Validate a plugin auth token and extract its claims.
	 * Returns null if invalid.
	 */
	validateToken(token: string): {
		pluginId: string;
		version: string;
		capabilities: string[];
		allowedHosts: string[];
		storageCollections: string[];
	} | null {
		const parts = token.split(".");
		if (parts.length !== 2) return null;

		const [payloadB64, hmacB64] = parts;
		if (!payloadB64 || !hmacB64) return null;

		const payload = Buffer.from(payloadB64, "base64url").toString();
		const { createHmac } = require("node:crypto") as typeof import("node:crypto");
		const expectedHmac = createHmac("sha256", this.masterSecret)
			.update(payload)
			.digest("base64url");

		if (hmacB64 !== expectedHmac) return null;

		try {
			return JSON.parse(payload) as {
				pluginId: string;
				version: string;
				capabilities: string[];
				allowedHosts: string[];
				storageCollections: string[];
			};
		} catch {
			return null;
		}
	}

	/**
	 * Start or restart workerd with current plugin configuration.
	 */
	private async restart(): Promise<void> {
		await this.stopWorkerd();

		// Ensure backing server is running
		if (!this.backingServer) {
			await this.startBackingServer();
		}

		// Create temp directory for config files
		if (!this.configDir) {
			this.configDir = join(tmpdir(), `emdash-workerd-${process.pid}-${Date.now()}`);
			await mkdir(this.configDir, { recursive: true });
		}

		// Write plugin code files to disk (workerd needs file paths)
		for (const [pluginId, plugin] of this.plugins) {
			const safeId = pluginId.replace(SAFE_ID_RE, "_");
			const wrapperCode = generatePluginWrapper(plugin.manifest, {
				site: this.siteInfo,
				backingServiceUrl: `http://127.0.0.1:${this.backingPort}`,
				authToken: plugin.token,
			});
			await writeFile(join(this.configDir, `${safeId}-wrapper.js`), wrapperCode);
			await writeFile(join(this.configDir, `${safeId}-plugin.js`), plugin.code);
		}

		// Generate capnp config
		const capnpConfig = generateCapnpConfig({
			plugins: this.plugins,
			backingServiceUrl: `http://127.0.0.1:${this.backingPort}`,
			configDir: this.configDir,
		});

		const configPath = join(this.configDir, "workerd.capnp");
		await writeFile(configPath, capnpConfig);

		// Spawn workerd
		this.workerdProcess = spawn("npx", ["workerd", "serve", configPath], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.epoch++;

		// Handle workerd exit with auto-restart on crash
		this.workerdProcess.on("exit", (code) => {
			this.healthy = false;
			if (this.shuttingDown) return;
			if (code !== 0 && code !== null) {
				console.error(`[emdash:workerd] workerd exited with code ${code}`);
				this.scheduleRestart();
			}
		});

		// Wait for workerd to be ready
		await this.waitForReady();
		this.healthy = true;
	}

	/**
	 * Wait for workerd to be ready by polling plugin ports.
	 */
	private async waitForReady(): Promise<void> {
		const startTime = Date.now();
		const timeout = 10_000;

		while (Date.now() - startTime < timeout) {
			try {
				// Try to reach the first plugin
				const firstPlugin = this.plugins.values().next().value;
				if (!firstPlugin) {
					this.healthy = true;
					return;
				}
				const res = await fetch(`http://127.0.0.1:${firstPlugin.port}/__health`, {
					signal: AbortSignal.timeout(1000),
				});
				if (res.ok || res.status === 404) {
					// workerd is responding (404 is fine, just means no health endpoint)
					return;
				}
			} catch {
				// Not ready yet
			}
			await new Promise((r) => setTimeout(r, 100));
		}

		throw new Error("[emdash:workerd] workerd failed to start within 10 seconds");
	}

	/**
	 * Stop the workerd child process.
	 */
	private async stopWorkerd(): Promise<void> {
		if (!this.workerdProcess) return;
		this.healthy = false;

		const proc = this.workerdProcess;
		this.workerdProcess = null;

		return new Promise((resolve) => {
			proc.on("exit", () => resolve());
			proc.kill("SIGTERM");
			// Force kill after 5 seconds
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		});
	}

	/**
	 * Start the backing service HTTP server.
	 */
	private async startBackingServer(): Promise<void> {
		const handler = createBackingServiceHandler(this);

		return new Promise((resolve, reject) => {
			this.backingServer = createServer(handler);
			// Bind to localhost only (not 0.0.0.0)
			this.backingServer.listen(0, "127.0.0.1", () => {
				const addr = this.backingServer!.address();
				if (addr && typeof addr === "object") {
					this.backingPort = addr.port;
				}
				resolve();
			});
			this.backingServer.on("error", reject);
		});
	}

	/**
	 * Stop the backing service HTTP server.
	 */
	private async stopBackingServer(): Promise<void> {
		if (!this.backingServer) return;
		return new Promise((resolve) => {
			this.backingServer!.close(() => resolve());
			this.backingServer = null;
		});
	}

	/** Get the database for backing service operations */
	get db() {
		return this.options.db;
	}

	/** Get the email send callback */
	get emailSend() {
		return this.emailSendCallback;
	}

	/** Get the current epoch (incremented on each workerd restart) */
	get currentEpoch() {
		return this.epoch;
	}
}

/**
 * A plugin running in a workerd V8 isolate.
 */
class WorkerdSandboxedPlugin implements SandboxedPlugin {
	readonly id: string;
	private manifest: PluginManifest;
	private port: number;
	private limits: ResolvedLimits;
	private runner: WorkerdSandboxRunner;
	/** Epoch at which this handle was created */
	private createdEpoch: number;

	constructor(
		id: string,
		manifest: PluginManifest,
		port: number,
		limits: ResolvedLimits,
		runner: WorkerdSandboxRunner,
	) {
		this.id = id;
		this.manifest = manifest;
		this.port = port;
		this.limits = limits;
		this.runner = runner;
		this.createdEpoch = runner.currentEpoch;
	}

	/**
	 * Check if this handle is still valid (workerd hasn't restarted since creation).
	 */
	private checkEpoch(): void {
		if (this.createdEpoch !== this.runner.currentEpoch) {
			throw new SandboxUnavailableError(
				this.id,
				`workerd has restarted (epoch ${this.createdEpoch} -> ${this.runner.currentEpoch}). Re-load the plugin.`,
			);
		}
		if (!this.runner.isHealthy()) {
			throw new SandboxUnavailableError(this.id, "workerd is not running");
		}
	}

	/**
	 * Invoke a hook in the sandboxed plugin via HTTP.
	 */
	async invokeHook(hookName: string, event: unknown): Promise<unknown> {
		this.checkEpoch();
		return this.withWallTimeLimit(`hook:${hookName}`, async () => {
			const res = await fetch(`http://127.0.0.1:${this.port}/hook/${hookName}`, {
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
		});
	}

	/**
	 * Invoke an API route in the sandboxed plugin via HTTP.
	 */
	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<unknown> {
		this.checkEpoch();
		return this.withWallTimeLimit(`route:${routeName}`, async () => {
			const res = await fetch(`http://127.0.0.1:${this.port}/route/${routeName}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ input, request }),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Plugin ${this.id} route ${routeName} failed: ${text}`);
			}
			return res.json();
		});
	}

	/**
	 * Terminate the sandboxed plugin.
	 */
	async terminate(): Promise<void> {
		// Nothing to do per-plugin. Workerd manages isolate lifecycle.
		// The plugin will be removed when the runner regenerates config.
	}

	/**
	 * Enforce wall-time limit on an operation.
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
}

/**
 * Factory function for creating the workerd sandbox runner.
 */
export const createSandboxRunner: SandboxRunnerFactory = (options) => {
	return new WorkerdSandboxRunner(options);
};
