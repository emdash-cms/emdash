/**
 * EmDash i18n Configuration
 *
 * Reads locale configuration from the virtual module (sourced from Astro config).
 * Initialized during runtime startup, then available via getI18nConfig().
 */

export interface I18nConfig {
	defaultLocale: string;
	locales: string[];
	/** Astro locale codes mapped to their canonical content locale paths. */
	localeAliases?: Record<string, string>;
	fallback?: Record<string, string>;
	prefixDefaultLocale?: boolean;
}

export const LOCALE_CODE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

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

/** Match a locale path or Astro code to the canonical content locale. */
export function resolveConfiguredLocale(
	locale: string,
	config: I18nConfig | null = getI18nConfig(),
): string {
	const configured = config?.locales.find(
		(candidate) => candidate.toLowerCase() === locale.toLowerCase(),
	);
	if (configured) return configured;

	const aliased = Object.entries(config?.localeAliases ?? {}).find(
		([code]) => code.toLowerCase() === locale.toLowerCase(),
	)?.[1];
	if (aliased === undefined) return locale;

	return (
		config?.locales.find((candidate) => candidate.toLowerCase() === aliased.toLowerCase()) ??
		aliased
	);
}

/** Stored locale spellings for one configured locale, in read-preference order. */
export function getLocaleCandidates(locale: string): string[] {
	const canonical = resolveConfiguredLocale(locale);
	const candidates = [canonical];
	const seen = new Set([canonical.toLowerCase()]);
	for (const code of Object.keys(getI18nConfig()?.localeAliases ?? {})) {
		if (resolveConfiguredLocale(code) === canonical && !seen.has(code.toLowerCase())) {
			candidates.push(code);
			seen.add(code.toLowerCase());
		}
	}
	return candidates;
}

/** Rank a stored row's locale for a lookup by path or code. */
export function getLocaleRank(stored: string, requested: string): number {
	const candidates = getLocaleCandidates(requested);
	const rank = candidates.findIndex(
		(candidate) => candidate.toLowerCase() === stored.toLowerCase(),
	);
	return rank === -1 ? candidates.length : rank;
}

/** Rank stored locale variants before moving to the next fallback locale. */
export function getLocaleChainRank(stored: string, chain: readonly string[]): number {
	let offset = 0;
	for (const locale of chain) {
		const candidates = getLocaleCandidates(locale);
		const rank = getLocaleRank(stored, locale);
		if (rank < candidates.length) return offset + rank;
		offset += candidates.length;
	}
	return offset;
}

/** Whether a string matches the locale-code subset accepted by EmDash. */
export function isValidLocaleCode(locale: string): boolean {
	return LOCALE_CODE_PATTERN.test(locale);
}

/** Resolve the locale for a new content row. */
export function resolveContentCreateLocale(
	locale: unknown,
	config: I18nConfig | null = getI18nConfig(),
): string {
	if (locale !== undefined) {
		if (typeof locale !== "string") {
			throw new Error("Invalid locale code: expected a string");
		}
		const configured = resolveConfiguredLocale(locale, config);
		if (config?.locales.includes(configured)) return configured;
		if (!isValidLocaleCode(locale)) {
			throw new Error(`Invalid locale code: "${locale}"`);
		}
		if (config) {
			throw new Error(`Locale "${locale}" is not configured for this site`);
		}
		return locale;
	}

	return config?.defaultLocale ?? "en";
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

	locale = resolveConfiguredLocale(locale, config);
	const chain: string[] = [locale];
	let current = locale;
	const visited = new Set<string>([locale]);

	while (config.fallback?.[current]) {
		// eslint-disable-next-line typescript/no-unnecessary-type-assertion -- noUncheckedIndexedAccess
		const next = resolveConfiguredLocale(config.fallback[current]!, config);
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
