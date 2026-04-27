/**
 * Auth Mode Detection
 *
 * Determines which authentication provider is active based on config.
 * Supports both passkey (default) and external auth providers via AuthDescriptor.
 */

import type { EmDashConfig } from "../astro/integration/runtime.js";
import type {
	AuthDescriptor,
	AuthProviderDescriptor,
	AuthRouteDescriptor,
	AuthResult,
	ExternalAuthConfig,
} from "./types.js";

export type {
	AuthDescriptor,
	AuthProviderDescriptor,
	AuthRouteDescriptor,
	AuthResult,
	ExternalAuthConfig,
};

/**
 * Passkey auth mode (default)
 */
export interface PasskeyAuthMode {
	type: "passkey";
}

/**
 * External auth provider mode (Cloudflare Access, etc.)
 */
export interface ExternalAuthMode {
	type: "external";
	/** Provider type identifier (e.g., "cloudflare-access") */
	providerType: string;
	/** Module to import for authentication */
	entrypoint: string;
	/** Provider-specific configuration */
	config: unknown;
}

/**
 * Union of all auth modes
 */
export type AuthMode = PasskeyAuthMode | ExternalAuthMode;

/**
 * Extended config type with auth.
 *
 * This is the same as `EmDashConfig` with an optional `auth` field.
 * Kept for backwards compatibility — prefer `EmDashConfig` in new code
 * since `getAuthMode` now accepts `EmDashConfig` directly.
 */
export interface EmDashConfigWithAuth extends EmDashConfig {
	auth?: AuthDescriptor;
}

/**
 * Determine the active auth mode from config.
 *
 * Accepts `EmDashConfig` (or subtype) — checks for `auth` field via duck typing.
 *
 * @param config EmDash configuration
 * @returns The active auth mode
 */
export function getAuthMode(
	config: (EmDashConfig & { auth?: AuthDescriptor }) | null | undefined,
): AuthMode {
	const auth = config?.auth;

	// Check for AuthDescriptor (transparent external auth like Cloudflare Access)
	if (auth && "entrypoint" in auth && auth.entrypoint) {
		return {
			type: "external",
			providerType: auth.type,
			entrypoint: auth.entrypoint,
			config: auth.config,
		};
	}

	// Default to passkey
	return { type: "passkey" };
}

/**
 * Check if an external auth provider is active
 */
export function isExternalAuthEnabled(
	config: (EmDashConfig & { auth?: AuthDescriptor }) | null | undefined,
): boolean {
	return getAuthMode(config).type === "external";
}

/**
 * Get external auth config if enabled
 */
export function getExternalAuthConfig(
	config: (EmDashConfig & { auth?: AuthDescriptor }) | null | undefined,
): ExternalAuthMode | null {
	const mode = getAuthMode(config);
	if (mode.type === "external") {
		return mode;
	}
	return null;
}
