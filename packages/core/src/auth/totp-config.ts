import type { EmDashConfig } from "../astro/integration/runtime.js";

/** TOTP defaults to enabled; only an explicit `enabled: false` opts out. */
export function isTotpEnabled(config: EmDashConfig | null | undefined): boolean {
	return config?.totp?.enabled !== false;
}
