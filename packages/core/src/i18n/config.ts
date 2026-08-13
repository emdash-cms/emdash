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

const I18N_CONFIG_KEY = Symbol.for("emdash:i18n-config");

function configStore(): Record<symbol, I18nConfig | null | undefined> {
	return globalThis;
}

/**
 * Initialize i18n config from virtual module data.
 * Called during runtime initialization.
 */
export function setI18nConfig(config: I18nConfig | null): void {
	configStore()[I18N_CONFIG_KEY] = config;
}

/**
 * Get the current i18n config.
 * Returns null if i18n is not configured.
 */
export function getI18nConfig(): I18nConfig | null {
	return configStore()[I18N_CONFIG_KEY] ?? null;
}

/** Match a locale to the exact casing used by the site configuration. */
export function resolveConfiguredLocale(locale: string): string {
	const config = getI18nConfig();
	return (
		config?.locales.find((configured) => configured.toLowerCase() === locale.toLowerCase()) ??
		locale
	);
}

/**
 * Check if i18n is enabled.
 * Returns true when multiple locales are configured.
 */
export function isI18nEnabled(): boolean {
	const config = getI18nConfig();
	return config != null && config.locales.length > 1;
}

/**
 * Resolve fallback locale chain for a given locale.
 * Returns array of locales to try, from most preferred to least.
 * Always ends with defaultLocale.
 */
export function getFallbackChain(locale: string): string[] {
	const config = getI18nConfig();
	if (!config) return [locale];

	const chain: string[] = [locale];
	let current = locale;
	const visited = new Set<string>([locale]);

	while (config.fallback?.[current]) {
		// eslint-disable-next-line typescript/no-unnecessary-type-assertion -- noUncheckedIndexedAccess
		const next = config.fallback[current]!;
		if (visited.has(next)) break; // prevent cycles
		chain.push(next);
		visited.add(next);
		current = next;
	}

	// Always end with defaultLocale if not already in chain
	if (!visited.has(config.defaultLocale)) {
		chain.push(config.defaultLocale);
	}

	return chain;
}
