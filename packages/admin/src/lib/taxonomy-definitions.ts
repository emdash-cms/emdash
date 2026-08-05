export interface LocalizedTaxonomyDefinition {
	id?: string;
	name: string;
	label: string;
	locale?: string;
	translationGroup?: string | null;
}

function normalizedLocale(locale: string | undefined): string | undefined {
	return locale?.trim().toLowerCase() || undefined;
}

/**
 * Collapse localized definition rows to one row per logical taxonomy.
 *
 * Selection prefers the active locale, then the configured default locale.
 * If neither exists, the lexically first locale/id/label wins so incomplete
 * translation groups remain usable and produce stable manifests and UI.
 * Legacy definitions without translation metadata are grouped by `name`.
 */
export function resolveTaxonomyDefinitions<T extends LocalizedTaxonomyDefinition>(
	definitions: readonly T[],
	activeLocale?: string,
	defaultLocale?: string,
): T[] {
	const active = normalizedLocale(activeLocale);
	const fallback = normalizedLocale(defaultLocale);
	const groups = new Map<string, T[]>();

	for (const definition of definitions) {
		const group = definition.translationGroup?.trim() || definition.name;
		const variants = groups.get(group);
		if (variants) variants.push(definition);
		else groups.set(group, [definition]);
	}

	return Array.from(groups.values(), (variants) => {
		const exact = active
			? variants.find((definition) => normalizedLocale(definition.locale) === active)
			: undefined;
		if (exact) return exact;

		const defaultVariant = fallback
			? variants.find((definition) => normalizedLocale(definition.locale) === fallback)
			: undefined;
		if (defaultVariant) return defaultVariant;

		return variants.toSorted((left, right) => {
			const leftKey = [normalizedLocale(left.locale) ?? "", left.id ?? "", left.name, left.label];
			const rightKey = [
				normalizedLocale(right.locale) ?? "",
				right.id ?? "",
				right.name,
				right.label,
			];
			return leftKey.join("\0").localeCompare(rightKey.join("\0"));
		})[0]!;
	});
}
