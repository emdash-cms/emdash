/**
 * EmDash i18n Configuration
 *
 * Reads locale configuration from the virtual module (sourced from Astro config).
 * Initialized during runtime startup, then available via getI18nConfig().
 */

export interface I18nConfig {
	defaultLocale: string;
	locales: string[];
	fallback?: Record<string, string>;
	prefixDefaultLocale?: boolean;
}

let _config: I18nConfig | null | undefined;

/**
 * Initialize i18n config from virtual module data.
 * Called during runtime initialization.
 */
export function setI18nConfig(config: I18nConfig | null): void {
	_config = config;
}

/**
 * Get the current i18n config.
 * Returns null if i18n is not configured.
 */
export function getI18nConfig(): I18nConfig | null {
	return _config ?? null;
}

/**
 * Check if i18n is enabled.
 * Returns true when multiple locales are configured.
 */
export function isI18nEnabled(): boolean {
	return _config != null && _config.locales.length > 1;
}

/**
 * Resolve fallback locale chain for a given locale.
 * Returns array of locales to try, from most preferred to least.
 * Always ends with defaultLocale.
 */
export function getFallbackChain(locale: string): string[] {
	if (!_config) return [locale];

	const chain: string[] = [locale];
	let current = locale;
	const visited = new Set<string>([locale]);

	while (_config.fallback?.[current]) {
		// eslint-disable-next-line typescript/no-unnecessary-type-assertion -- noUncheckedIndexedAccess
		const next = _config.fallback[current]!;
		if (visited.has(next)) break; // prevent cycles
		chain.push(next);
		visited.add(next);
		current = next;
	}

	// Always end with defaultLocale if not already in chain
	if (!visited.has(_config.defaultLocale)) {
		chain.push(_config.defaultLocale);
	}

	return chain;
}
