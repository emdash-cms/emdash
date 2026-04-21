/**
 * Flatten a Contentful configLocaleList entry into a locale_list record.
 *
 * Contentful uses camelCase field names per locale:
 *   { name: "...", enUs: "Translated", deDe: "No Page" }
 *
 * This converts to hyphenated BCP 47 keys:
 *   { "en-us": "Translated", "de-de": "No Page" }
 */

export function flattenLocaleList(fields: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (key === "name") continue; // skip the display name field
		if (typeof value === "string") {
			// Convert camelCase key to locale code: enUs → en-us
			const localeCode = key.replace(/([A-Z])/g, "-$1").toLowerCase();
			result[localeCode] = value;
		}
	}
	return result;
}
