/**
 * Plugin Sandbox Types
 *
 * Defines interfaces for running plugins in sandboxed V8 isolates.
 * The SandboxRunner interface is implemented by platform adapters
 * (e.g., Cloudflare Worker Loader) to provide isolation.
 *
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { PluginManifest, RequestMeta } from "../types.js";

/**
 * Resource limits for sandboxed plugins.
 * Enforced by the sandbox runtime (e.g., Worker Loader).
 */
export interface ResourceLimits {
	/** CPU time per invocation in milliseconds (default: 50ms) */
	cpuMs?: number;
	/** Memory limit in MB (default: 128MB) */
	memoryMb?: number;
	/** Maximum subrequests per invocation (default: 10) */
	subrequests?: number;
	/** Wall-clock time limit in milliseconds (default: 30000ms) */
	wallTimeMs?: number;
}

/**
 * Storage interface for loading plugin code.
 * Could be R2, local filesystem, or any other storage backend.
 */
export interface PluginCodeStorage {
	/** Get plugin bundle code by path */
	get(path: string): Promise<string | null>;
	/** Check if a bundle exists */
	exists(path: string): Promise<boolean>;
}

/**
 * Serialized email message for sandbox RPC transport.
 * Matches the core EmailMessage type but uses only serializable fields.
 */
export interface SandboxEmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

/**
 * Callback for sending email from a sandboxed plugin.
 * The sandbox runner wires this up from the EmailPipeline.
 *
 * @param message - The email message to send
 * @param pluginId - The sending plugin's ID (used as source)
 */
export type SandboxEmailSendCallback = (
	message: SandboxEmailMessage,
	pluginId: string,
) => Promise<void>;

/**
 * Options for creating a sandbox runner
 */
export interface SandboxOptions {
	/** Storage interface for loading plugin code */
	storage?: PluginCodeStorage;
	/** Database for bridge operations */
	db: Kysely<Database>;
	/** Default resource limits */
	limits?: ResourceLimits;
	/** Site info for plugin context (injected into wrapper at generation time) */
	siteInfo?: { name: string; url: string; locale: string };
	/** Email send callback, wired from the EmailPipeline by the runtime */
	emailSend?: SandboxEmailSendCallback;
	/**
	 * Media storage adapter for sandboxed plugin uploads and deletes.
	 * When provided, plugins with write:media can upload and delete files
	 * via ctx.media.upload() and ctx.media.delete().
	 */
	mediaStorage?: {
		upload(options: { key: string; body: Uint8Array; contentType: string }): Promise<unknown>;
		delete(key: string): Promise<unknown>;
	};
}

/**
 * A sandboxed plugin instance.
 * Provides methods to invoke hooks and routes in the isolated environment.
 */
export interface SandboxedPlugin {
	/** Unique identifier: `${manifest.id}:${manifest.version}` */
	readonly id: string;

	/**
	 * Invoke a hook in the sandboxed plugin.
	 *
	 * @param hookName - Name of the hook (e.g., "content:beforeSave")
	 * @param event - Event data to pass to the hook
	 * @returns Hook result (transformed content, void, etc.)
	 */
	invokeHook(hookName: string, event: unknown): Promise<unknown>;

	/**
	 * Invoke an API route in the sandboxed plugin.
	 *
	 * @param routeName - Name of the route
	 * @param input - Validated input data
	 * @param request - Serialized request info for context
	 * @returns Route response data
	 */
	invokeRoute(routeName: string, input: unknown, request: SerializedRequest): Promise<unknown>;

	/**
	 * Terminate the sandboxed plugin.
	 * Releases resources and prevents further invocations.
	 */
	terminate(): Promise<void>;
}

/**
 * Serialized request for RPC transport.
 * Worker Loader can't pass Request objects directly.
 */
export interface SerializedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** Normalized request metadata extracted before RPC serialization */
	meta: RequestMeta;
}

/**
 * Sandbox runner interface.
 * Platform adapters implement this to provide plugin isolation.
 */
export interface SandboxRunner {
	/**
	 * Check if sandboxing is available on this platform.
	 * Returns false for platforms that don't support isolation.
	 */
	isAvailable(): boolean;

	/**
	 * Check if the sandbox runtime is currently healthy.
	 * For in-process runners this always returns true.
	 * For sidecar-based runners (workerd), returns false if the
	 * child process has crashed and hasn't been restarted yet.
	 */
	isHealthy(): boolean;

	/**
	 * Load a sandboxed plugin from code.
	 *
	 * @param manifest - Plugin manifest with metadata and capabilities
	 * @param code - The bundled plugin JavaScript code
	 * @returns A sandboxed plugin instance
	 * @throws If sandboxing is not available or plugin can't be loaded
	 */
	load(manifest: PluginManifest, code: string): Promise<SandboxedPlugin>;

	/**
	 * Set the email send callback for sandboxed plugins.
	 * Called after the EmailPipeline is created, since the pipeline
	 * doesn't exist when the sandbox runner is constructed.
	 */
	setEmailSend(callback: SandboxEmailSendCallback | null): void;

	/**
	 * Terminate all loaded sandboxed plugins.
	 * Called during shutdown or when reconfiguring.
	 */
	terminateAll(): Promise<void>;
}

/**
 * Error thrown when the sandbox runtime is unavailable.
 * This happens when the sidecar process has crashed or hasn't started.
 */
export class SandboxUnavailableError extends Error {
	constructor(pluginId: string, reason: string) {
		super(`Plugin sandbox unavailable for ${pluginId}: ${reason}`);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * Factory function type for creating sandbox runners.
 * Exported by platform adapters (e.g., @emdash-cms/adapter-cloudflare/sandbox).
 *
 * @example
 * ```typescript
 * // In @emdash-cms/adapter-cloudflare/sandbox.ts
 * export const createSandboxRunner: SandboxRunnerFactory = (options) => {
 *   return new CloudflareSandboxRunner(options);
 * };
 * ```
 */
export type SandboxRunnerFactory = (options: SandboxOptions) => SandboxRunner;
