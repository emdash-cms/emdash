/**
 * Local Media Provider
 *
 * The built-in media provider that wraps the current storage adapter and media database.
 * This is the default provider and is available unless explicitly disabled.
 */

import type { MediaProviderDescriptor } from "./types.js";

export interface LocalMediaConfig {
	/** Whether the local provider is enabled (default true) */
	enabled?: boolean;
}

/**
 * Local media provider configuration
 *
 * @example
 * ```ts
 * import { localMedia } from "emdash/media";
 *
 * emdash({
 *   mediaProviders: [
 *     localMedia(), // Uses defaults
 *     // or: localMedia({ enabled: false }) to disable
 *   ],
 * })
 * ```
 */
export function localMedia(config: LocalMediaConfig = {}): MediaProviderDescriptor {
	return {
		id: "local",
		name: "Library",
		icon: "📁",
		entrypoint: "emdash/internal/media/local-runtime",
		capabilities: {
			browse: true,
			search: false, // TODO: Add search support
			upload: true,
			delete: true,
		},
		config: {
			enabled: config.enabled ?? true,
		},
	};
}
