/**
 * No-op Sandbox Runner
 *
 * Default implementation that doesn't support sandboxing.
 * Used on platforms without Worker Loader (Node.js, Deno, etc.).
 *
 */

import type { PluginManifest } from "../types.js";
import type { SandboxRunner, SandboxedPlugin, SandboxOptions } from "./types.js";

/**
 * Error thrown when attempting to use sandboxing on an unsupported platform.
 */
export class SandboxNotAvailableError extends Error {
	constructor() {
		super(
			"Plugin sandboxing is not available. " +
				"Configure a sandbox runner: use @emdash-cms/cloudflare/sandbox on Cloudflare, " +
				"or @emdash-cms/workerd/sandbox on Node.js (requires workerd). " +
				"Without sandboxing, use trusted plugins (from config) instead.",
		);
		this.name = "SandboxNotAvailableError";
	}
}

/**
 * No-op sandbox runner for platforms without isolation support.
 *
 * - `isAvailable()` returns false
 * - `load()` throws SandboxNotAvailableError
 * - `terminateAll()` is a no-op
 *
 * This is the default runner when no platform adapter is configured.
 */
export class NoopSandboxRunner implements SandboxRunner {
	/**
	 * Always returns false - sandboxing is not available.
	 */
	isAvailable(): boolean {
		return false;
	}

	/**
	 * Always returns false - no sandbox runtime to be healthy.
	 */
	isHealthy(): boolean {
		return false;
	}

	/**
	 * Always throws - can't load sandboxed plugins without isolation.
	 */
	async load(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_manifest: PluginManifest,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_code: string,
	): Promise<SandboxedPlugin> {
		throw new SandboxNotAvailableError();
	}

	/**
	 * No-op - sandboxing not available, email callback is irrelevant.
	 */
	setEmailSend(): void {
		// Nothing to do
	}

	/**
	 * No-op - nothing to terminate.
	 */
	async terminateAll(): Promise<void> {
		// Nothing to do
	}
}

/**
 * Create a no-op sandbox runner.
 * This is used as the default when no platform adapter is configured.
 */
export function createNoopSandboxRunner(_options?: SandboxOptions): SandboxRunner {
	return new NoopSandboxRunner();
}
