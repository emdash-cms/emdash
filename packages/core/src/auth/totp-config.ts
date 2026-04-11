/**
 * Tiny helper for checking whether TOTP is enabled in the runtime
 * EmDashConfig. Shared between the two setup routes and the login
 * route so the check is stated in exactly one place.
 *
 * TOTP defaults to enabled because the entire justification for the
 * feature is to unblock deployers whose users can't reliably use
 * passkeys. A deployer opts out by setting `totp: { enabled: false }`
 * in their astro.config.mjs.
 *
 * When disabled, every TOTP route returns 404 (not 403) so that the
 * feature is invisible to callers — same shape as a missing route —
 * which keeps probes from confirming the feature exists at all.
 */

import type { EmDashConfig } from "../astro/integration/runtime.js";

/**
 * Returns true when TOTP should be served. Missing config, missing
 * totp block, and `enabled: true` all evaluate to true. Only an
 * explicit `enabled: false` opts out.
 */
export function isTotpEnabled(config: EmDashConfig | null | undefined): boolean {
	return config?.totp?.enabled !== false;
}
