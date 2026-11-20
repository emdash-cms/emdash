interface SwitchField {
	kind: string;
	required?: boolean;
	widget?: string;
	validation?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredSwitchSlugs(subFields: unknown): string[] {
	if (!Array.isArray(subFields)) return [];
	return subFields.flatMap((subField: unknown) =>
		isRecord(subField) &&
		subField.type === "boolean" &&
		subField.required === true &&
		typeof subField.slug === "string"
			? [subField.slug]
			: [],
	);
}

function rowWithSwitchesOff(slugs: string[], row: unknown): unknown {
	if (!isRecord(row)) return row;
	const unset = slugs.filter((slug) => row[slug] == null);
	if (unset.length === 0) return row;
	return { ...row, ...Object.fromEntries(unset.map((slug) => [slug, false])) };
}

/**
 * Saved content with `false` for each required switch that has no value, as in repeater
 * rows saved before the switch was added. A switch shows a missing value as off, but
 * the server refuses to save a required one without a value.
 *
 * Optional switches stay unset: an update copies each non-translatable value it sends
 * to the entry's other locales, so a filled `false` would overwrite theirs.
 *
 * Returns `data` itself when no value is missing.
 */
export function withRequiredSwitchesOff(
	fields: Record<string, SwitchField>,
	data: Record<string, unknown>,
): Record<string, unknown> {
	let next = data;
	for (const [name, field] of Object.entries(fields)) {
		if (field.widget) continue;
		const value = data[name];
		let filled = value;
		if (field.kind === "boolean" && field.required && value == null) {
			filled = false;
		} else if (field.kind === "repeater" && Array.isArray(value)) {
			const slugs = requiredSwitchSlugs(field.validation?.subFields);
			const rows = value.map((row: unknown) => rowWithSwitchesOff(slugs, row));
			if (rows.some((row, index) => row !== value[index])) filled = rows;
		}
		if (filled !== value) next = { ...next, [name]: filled };
	}
	return next;
}
