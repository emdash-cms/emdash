import type { EmDashConfig } from "../astro/integration/runtime.js";
import { resolveAuthSecret } from "./auth-secret.js";

/** Config-level check: defaults enabled, only an explicit `enabled: false` opts out. */
export function isTotpEnabled(config: EmDashConfig | null | undefined): boolean {
	return config?.totp?.enabled !== false;
}

/**
 * Whether TOTP is actually serviceable right now — config allows it AND
 * EMDASH_AUTH_SECRET is present. Used by /api/manifest and /api/setup/status
 * so the UI doesn't advertise a method that every call would immediately
 * fail with AUTH_SECRET_MISSING. Route handlers still use the stricter
 * isTotpEnabled check so an env that's removed after manifest fetch
 * falls through to the structured AUTH_SECRET_MISSING error.
 */
export function isTotpAvailable(config: EmDashConfig | null | undefined): boolean {
	if (!isTotpEnabled(config)) return false;
	return resolveAuthSecret().ok;
}
