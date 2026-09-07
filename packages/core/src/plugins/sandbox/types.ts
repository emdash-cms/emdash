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
import type { PluginManifest, RequestMeta, UserInfo } from "../types.js";

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
	/** Called immediately before a sandboxed plugin content mutation. */
	beforeContentWrite?: () => Promise<void>;
	/** Default resource limits */
	limits?: ResourceLimits;
	/** Site info for plugin context (injected into wrapper at generation time) */
	siteInfo?: {
		name: string;
		url: string;
		locale: string;
		trailingSlash?: "always" | "never" | "ignore";
	};
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
 * Handle to a sandboxed plugin running inside an isolate. Returned
 * by `SandboxRunner.load` and held by the runtime's cache so hooks /
 * routes can be invoked across the isolate boundary. Distinct from
 * the author-facing `SandboxedPlugin` type in `emdash/plugin`, which
 * describes the source-level shape of a plugin's default export.
 */
export interface SandboxedPluginInstance {
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
	/**
	 * Authenticated caller for private routes, resolved by the host before
	 * dispatch. Undefined for public routes and unbound machine tokens.
	 */
	user?: UserInfo;
}

const SANDBOX_ROUTE_ERROR_DEFINITIONS = {
	MEDIA_USAGE_ACTIVATION_IN_PROGRESS: {
		message: "Media usage activation is in progress",
		status: 503,
	},
	MEDIA_USAGE_ACTIVATION_CHECK_FAILED: {
		message: "Unable to verify media usage activation state",
		status: 503,
	},
} as const;

export type SandboxRouteErrorCode = keyof typeof SANDBOX_ROUTE_ERROR_DEFINITIONS;

export interface SandboxRouteErrorDetails {
	code: SandboxRouteErrorCode;
	message: string;
	status: 503;
}

export interface SandboxRouteErrorEnvelope {
	__emdashSandboxRouteError: true;
	error: SandboxRouteErrorDetails;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSandboxRouteErrorCode(value: unknown): value is SandboxRouteErrorCode {
	return typeof value === "string" && value in SANDBOX_ROUTE_ERROR_DEFINITIONS;
}

export function getSandboxRouteErrorDetails(error: unknown): SandboxRouteErrorDetails | null {
	if (!isRecord(error)) return null;

	const propertyCode = isSandboxRouteErrorCode(error.code) ? error.code : null;
	const nameCode =
		error instanceof Error && isSandboxRouteErrorCode(error.name) ? error.name : null;
	if (propertyCode && nameCode && propertyCode !== nameCode) return null;

	const code = propertyCode ?? nameCode;
	if (!code || (error.status !== undefined && error.status !== 503)) return null;

	return {
		code,
		...SANDBOX_ROUTE_ERROR_DEFINITIONS[code],
	};
}

export function createSandboxRouteError(
	code: SandboxRouteErrorCode,
): Error & SandboxRouteErrorDetails {
	const details: SandboxRouteErrorDetails = {
		code,
		...SANDBOX_ROUTE_ERROR_DEFINITIONS[code],
	};
	return Object.assign(new Error(details.message), details, { name: code });
}

export function createSandboxRouteErrorEnvelope(error: unknown): SandboxRouteErrorEnvelope | null {
	const details = getSandboxRouteErrorDetails(error);
	return details ? { __emdashSandboxRouteError: true, error: details } : null;
}

export function getSandboxRouteErrorEnvelope(value: unknown): SandboxRouteErrorEnvelope | null {
	if (!isRecord(value) || value.__emdashSandboxRouteError !== true) return null;
	const details = getSandboxRouteErrorDetails(value.error);
	return details ? { __emdashSandboxRouteError: true, error: details } : null;
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
	load(manifest: PluginManifest, code: string): Promise<SandboxedPluginInstance>;

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
