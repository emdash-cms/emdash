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

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile, mkdir, rm, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequire } from "node:module";
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
import type { BackingServiceHandler } from "./backing-service.js";
import { generateCapnpConfig } from "./capnp.js";
import { MiniflareDevRunner } from "./dev-runner.js";
import { generatePluginWrapper } from "./wrapper.js";

/** Replace non-alphanumeric chars for safe file/worker names */
const SAFE_ID_RE = /[^a-z0-9_-]/gi;

// Unix socket support is wired but disabled until workerd capnp external
// address format is validated. Enabling: `process.platform !== "win32"`.
const USE_UNIX_SOCKET = false;

const activeRunners = new Set<WorkerdSandboxRunner>();
let sigHandlerRegistered = false;

function registerSigHandler(runner: WorkerdSandboxRunner): void {
	activeRunners.add(runner);
	if (!sigHandlerRegistered) {
		sigHandlerRegistered = true;
		process.on("SIGTERM", () => {
			for (const r of activeRunners) {
				r["shuttingDown"] = true;
				void r.terminateAll();
			}
		});
	}
}

function unregisterSigHandler(runner: WorkerdSandboxRunner): void {
	activeRunners.delete(runner);
}

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
	private backingService: BackingServiceHandler | null = null;
	private backingSocketPath: string | null = null;
	private eagerStartTimer: ReturnType<typeof setTimeout> | null = null;

	/** workerd child process */
	private workerdProcess: ChildProcess | null = null;

	/** Master secret for generating per-plugin auth tokens */
	private masterSecret = randomBytes(32).toString("hex");

	/**
	 * Per-startup token the runner sends on every hook/route invocation
	 * to its plugins. Plugins reject requests without this token, which
	 * prevents same-host attackers from invoking plugin hooks directly
	 * via the per-plugin TCP listener on 127.0.0.1.
	 */
	private invokeToken = randomBytes(32).toString("hex");

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

	/** Whether workerd needs to be (re)started before next invocation */
	private needsRestart = false;

	/** Serializes concurrent ensureRunning() calls */
	private startupPromise: Promise<void> | null = null;

	/** Crash restart state */
	private crashCount = 0;
	private crashWindowStart = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private shuttingDown = false;

	/**
	 * True when stopWorkerd() is intentionally tearing down the child
	 * (e.g., on intentional restart() to reload plugins). The exit handler
	 * uses this to skip crash recovery for intentional stops, otherwise
	 * every plugin reload would trigger a phantom crash-restart cycle.
	 */
	private intentionalStop = false;

	constructor(options: SandboxOptions) {
		this.options = options;
		this.limits = resolveLimits(options.limits);
		this.siteInfo = options.siteInfo;
		this.emailSendCallback = options.emailSend ?? null;

		// Warn about unenforceable resource limits. Standalone workerd
		// only supports wall-time enforcement on the Node path (via
		// Promise.race). cpuMs, memoryMb, and subrequests are Cloudflare
		// platform features and are not enforced here.
		if (
			options.limits &&
			(options.limits.cpuMs !== undefined ||
				options.limits.memoryMb !== undefined ||
				options.limits.subrequests !== undefined)
		) {
			console.warn(
				"[emdash:workerd] cpuMs, memoryMb, and subrequests limits are not enforced " +
					"by standalone workerd. Only wallTimeMs is enforced on the Node path. " +
					"For full resource isolation, deploy on Cloudflare Workers.",
			);
		}

		// Forward SIGTERM to workerd child for clean shutdown
		registerSigHandler(this);
	}

	/**
	 * Check if workerd is available on this system.
	 */
	isAvailable(): boolean {
		try {
			const bin = this.resolveWorkerdBinary();
			// execFileSync (not execSync) so paths with spaces or shell
			// metacharacters are passed verbatim, not shell-split.
			execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Resolve the workerd binary path from node_modules.
	 * Avoids npx which can download binaries at runtime (supply chain risk).
	 */
	private resolveWorkerdBinary(): string {
		try {
			// workerd package: main is lib/main.js, bin is bin/workerd
			const esmRequire = createRequire(import.meta.url);
			const workerdMain = esmRequire.resolve("workerd");
			// workerdMain = .../node_modules/workerd/lib/main.js
			// binary = .../node_modules/workerd/bin/workerd
			const pkgDir = join(workerdMain, "..", "..");
			const binName = process.platform === "win32" ? "workerd.exe" : "workerd";
			return join(pkgDir, "bin", binName);
		} catch {
			// Fallback: try workerd on PATH
			return "workerd";
		}
	}

	/**
	 * Check if the workerd process is currently healthy.
	 *
	 * Returns false when needsRestart is set (process not yet started or
	 * needs to be restarted), since callers using this for monitoring or
	 * external health checks expect "running and serving requests".
	 *
	 * Internal callers that just want to defer-then-invoke should use
	 * ensureRunning() instead, which handles the deferred startup.
	 */
	isHealthy(): boolean {
		if (this.needsRestart) return false;
		return this.healthy && this.workerdProcess !== null && !this.workerdProcess.killed;
	}

	/**
	 * Ensure workerd is running. Called before first invocation.
	 * Batches plugin loading: all plugins are registered via load(),
	 * then workerd starts once on the first hook/route call.
	 */
	async ensureRunning(): Promise<void> {
		// If a startup is already in progress, wait for it
		if (this.startupPromise) {
			await this.startupPromise;
			return;
		}
		if (!this.needsRestart) return;

		// Serialize: concurrent callers await the same promise.
		// Don't clear needsRestart until startup succeeds, so a transient
		// failure (waitForReady timeout, spawn error) can be retried by
		// the next invocation.
		this.startupPromise = this.restart();
		try {
			await this.startupPromise;
			this.needsRestart = false;
		} finally {
			// Always clear startupPromise so a failed start doesn't block
			// subsequent retries. needsRestart stays true on failure (set above
			// only after the await succeeds), enabling automatic retry.
			this.startupPromise = null;
		}
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

		// Defer workerd start: collect all plugins first, start once.
		// The runtime loads plugins sequentially, so we batch by deferring
		// the actual workerd spawn until the first hook/route invocation.
		this.needsRestart = true;
		this.scheduleEagerStart();

		return new WorkerdSandboxedPlugin(pluginId, manifest, port, this.limits, this);
	}

	/**
	 * Unload a single plugin (called from WorkerdSandboxedPlugin.terminate()).
	 *
	 * Removes the plugin from the in-memory map and marks needsRestart so
	 * the next invocation rebuilds workerd without it. We don't restart
	 * eagerly here because update/uninstall flows often unload immediately
	 * before loading the new version, and back-to-back restarts are wasteful.
	 */
	unloadPlugin(pluginId: string): void {
		if (this.plugins.delete(pluginId)) {
			this.backingService?.removePlugin(pluginId);
			if (this.plugins.size === 0) {
				void this.stopWorkerd();
			} else {
				this.needsRestart = true;
				this.scheduleEagerStart();
			}
		}
	}

	/**
	 * Schedule eager workerd start with a short debounce.
	 * Batches rapid load/unload sequences into a single restart.
	 */
	private scheduleEagerStart(): void {
		if (this.eagerStartTimer) clearTimeout(this.eagerStartTimer);
		this.eagerStartTimer = setTimeout(() => {
			this.eagerStartTimer = null;
			void this.ensureRunning();
		}, 50);
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
		if (this.eagerStartTimer) {
			clearTimeout(this.eagerStartTimer);
			this.eagerStartTimer = null;
		}
		unregisterSigHandler(this);
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
			// Just mark as needing restart. The next plugin invocation will
			// drive the actual restart through ensureRunning(), which serializes
			// concurrent attempts via startupPromise. We don't call ensureRunning()
			// here because that would race with plugin-invocation-driven calls
			// (the finally block clears startupPromise so a second concurrent
			// caller could enter restart() while the first is still running).
			//
			// If no plugin invocations happen after a crash, there's nothing
			// to recover for, so deferring restart until next use is fine.
			this.needsRestart = true;
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
		const payloadB64 = Buffer.from(payload).toString("base64url");
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
		const expectedHmac = createHmac("sha256", this.masterSecret)
			.update(payload)
			.digest("base64url");

		// Constant-time comparison to prevent timing side channels
		const a = Buffer.from(hmacB64);
		const b = Buffer.from(expectedHmac);
		if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

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
				backingServiceUrl: this.backingServiceUrl,
				authToken: plugin.token,
				invokeToken: this.invokeToken,
			});
			await writeFile(join(this.configDir, `${safeId}-wrapper.js`), wrapperCode);
			await writeFile(join(this.configDir, `${safeId}-plugin.js`), plugin.code);
		}

		// Generate capnp config. Note: cpuMs/memoryMb/subrequests from
		// this.limits are NOT passed here because standalone workerd doesn't
		// support per-worker enforcement of those limits (Cloudflare-only).
		// Only wallTimeMs is enforced (via Promise.race in invokeHook/invokeRoute).
		const capnpConfig = generateCapnpConfig({
			plugins: this.plugins,
			backingServiceAddress: this.backingServiceAddress,
			configDir: this.configDir,
		});

		const configPath = join(this.configDir, "workerd.capnp");
		await writeFile(configPath, capnpConfig);

		// Spawn workerd using resolved binary (not npx)
		const workerdBin = this.resolveWorkerdBinary();
		this.workerdProcess = spawn(workerdBin, ["serve", configPath], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.epoch++;

		// Drain stdout/stderr to prevent pipe buffer deadlock
		this.workerdProcess.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(`[emdash:workerd] ${chunk.toString()}`);
		});
		this.workerdProcess.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(`[emdash:workerd] ${chunk.toString()}`);
		});

		// Handle workerd exit with auto-restart on crash
		this.workerdProcess.on("exit", (code, signal) => {
			this.healthy = false;
			this.workerdProcess = null;
			if (this.shuttingDown) return;
			// Skip crash recovery for intentional stops (e.g., reload via
			// stopWorkerd() during restart()). Reset the flag so the next
			// exit, if it happens unexpectedly, is treated as a real crash.
			if (this.intentionalStop) {
				this.intentionalStop = false;
				return;
			}
			// Restart on non-zero exit code OR signal-based termination (OOM, kill)
			if ((code !== 0 && code !== null) || signal) {
				const reason = signal ? `signal ${signal}` : `code ${code}`;
				console.error(`[emdash:workerd] workerd exited with ${reason}`);
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
				const res = await fetch(`http://127.0.0.1:${firstPlugin.port}/__ready`, {
					signal: AbortSignal.timeout(1000),
					headers: { Authorization: `Bearer ${this.invokeToken}` },
				});
				if (res.ok) {
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
	 *
	 * Marks the stop as intentional so the exit handler in restart() does
	 * not interpret it as a crash and trigger scheduleRestart(). Without
	 * this, every intentional reload (plugin install/uninstall) would
	 * cascade into a phantom crash-restart cycle.
	 */
	private async stopWorkerd(): Promise<void> {
		if (!this.workerdProcess) return;
		this.healthy = false;
		this.intentionalStop = true;

		const proc = this.workerdProcess;
		this.workerdProcess = null;

		// Fast path: process already exited (exitCode is set after exit)
		if (proc.exitCode !== null) {
			return;
		}

		return new Promise((resolve) => {
			let exited = false;
			proc.on("exit", () => {
				exited = true;
				resolve();
			});
			proc.kill("SIGTERM");
			// Force kill after 5 seconds if SIGTERM was ignored.
			// Use the local `exited` flag (not proc.killed, which flips
			// to true as soon as a signal is queued, not when the process
			// actually exits).
			setTimeout(() => {
				if (!exited) {
					proc.kill("SIGKILL");
				}
			}, 5000);
		});
	}

	/**
	 * Start the backing service HTTP server.
	 */
	private async startBackingServer(): Promise<void> {
		this.backingService = createBackingServiceHandler(this);

		return new Promise((resolve, reject) => {
			this.backingServer = createServer(this.backingService!.handler);

			if (USE_UNIX_SOCKET) {
				const socketPath = join(tmpdir(), `emdash-sandbox-${process.pid}-${Date.now()}.sock`);
				this.backingSocketPath = socketPath;
				this.backingServer.listen(socketPath, () => {
					resolve();
				});
			} else {
				// Windows fallback: TCP on localhost
				this.backingServer.listen(0, "127.0.0.1", () => {
					const addr = this.backingServer!.address();
					if (addr && typeof addr === "object") {
						this.backingPort = addr.port;
					}
					resolve();
				});
			}

			this.backingServer.on("error", reject);
		});
	}

	/** Address string for capnp config */
	get backingServiceAddress(): string {
		if (USE_UNIX_SOCKET && this.backingSocketPath) {
			return `unix:${this.backingSocketPath}`;
		}
		return `127.0.0.1:${this.backingPort}`;
	}

	/** URL for wrapper code to use as BACKING_URL.
	 * With globalOutbound the hostname is just a label — all outbound
	 * fetch() calls route through the external service regardless. */
	get backingServiceUrl(): string {
		if (USE_UNIX_SOCKET && this.backingSocketPath) {
			return "http://emdash-backing";
		}
		return `http://127.0.0.1:${this.backingPort}`;
	}

	/**
	 * Stop the backing service HTTP server.
	 */
	private async stopBackingServer(): Promise<void> {
		if (!this.backingServer) return;
		const socketPath = this.backingSocketPath;
		return new Promise<void>((resolve) => {
			this.backingServer!.close(() => {
				if (socketPath) {
					unlink(socketPath).catch(() => {});
					this.backingSocketPath = null;
				}
				resolve();
			});
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

	/** Get the media storage adapter */
	get mediaStorage() {
		return this.options.mediaStorage ?? null;
	}

	/** Get the per-startup invoke token (sent on hook/route requests to plugins) */
	get invokeAuthToken() {
		return this.invokeToken;
	}

	/**
	 * Look up the storage config (with indexes) for a specific plugin version.
	 * The plugins map is keyed by `${id}:${version}`. Looking up by id alone
	 * could return a stale version's storage schema after a plugin upgrade,
	 * so we require both id and version.
	 */
	getPluginStorageConfig(pluginId: string, version: string): Record<string, unknown> | undefined {
		const plugin = this.plugins.get(`${pluginId}:${version}`);
		if (plugin) {
			return plugin.manifest.storage as Record<string, unknown> | undefined;
		}
		return undefined;
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
	}

	/**
	 * Ensure workerd is running before invoking a hook or route.
	 * On first call, this triggers deferred workerd startup (batching
	 * all plugins registered via load() into a single workerd start).
	 */
	private async ensureReady(): Promise<void> {
		await this.runner.ensureRunning();
		if (!this.runner.isHealthy()) {
			throw new SandboxUnavailableError(this.id, "workerd is not running");
		}
	}

	/**
	 * Invoke a hook in the sandboxed plugin via HTTP.
	 */
	async invokeHook(hookName: string, event: unknown): Promise<unknown> {
		await this.ensureReady();
		return this.withWallTimeLimit(`hook:${hookName}`, async () => {
			const res = await fetch(`http://127.0.0.1:${this.port}/hook/${hookName}`, {
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

	/**
	 * Invoke an API route in the sandboxed plugin via HTTP.
	 */
	async invokeRoute(
		routeName: string,
		input: unknown,
		request: SerializedRequest,
	): Promise<unknown> {
		await this.ensureReady();
		return this.withWallTimeLimit(`route:${routeName}`, async () => {
			const res = await fetch(`http://127.0.0.1:${this.port}/route/${routeName}`, {
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

	/**
	 * Terminate the sandboxed plugin.
	 *
	 * Removes this plugin from the runner's plugins map and marks
	 * needsRestart so the next load/invocation rebuilds workerd without
	 * its listener. Without this, marketplace update/uninstall would
	 * leak old plugin entries (and their ports) until full server restart.
	 */
	async terminate(): Promise<void> {
		this.runner.unloadPlugin(this.id);
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
 *
 * Selects MiniflareDevRunner only when explicitly in development mode
 * (NODE_ENV === "development"). Any other value — including unset (which
 * is the default for `node server.js` and `astro preview` on self-hosted
 * deployments) — uses the production WorkerdSandboxRunner.
 *
 * The dev runner skips production hardening (wall-time wrapper, child
 * process supervision, crash/restart with backoff), so falling back to
 * it silently in production would be a security regression.
 *
 * Operators who want the dev runner explicitly should set NODE_ENV=development.
 */
export const createSandboxRunner: SandboxRunnerFactory = (options) => {
	const isDev = process.env.EMDASH_SANDBOX_DEV === "1" || process.env.NODE_ENV === "development";

	if (isDev) {
		// MiniflareDevRunner is statically imported (no miniflare dependency
		// at this point — dev-runner only imports miniflare dynamically inside
		// rebuild()). isAvailable() does the actual miniflare resolution check.
		const devRunner = new MiniflareDevRunner(options);
		if (devRunner.isAvailable()) {
			return devRunner;
		}
	}

	return new WorkerdSandboxRunner(options);
};
