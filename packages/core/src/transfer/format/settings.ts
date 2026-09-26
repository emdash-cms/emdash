/**
 * Classification of `options` rows for site transfer.
 *
 * - `portable`: exported as `setting` records (explicit allowlist, never a
 *   prefix match).
 * - `targetLocal`: belongs to the target installation and is never exported
 *   or overwritten by an import.
 * - `excluded`: everything else (secrets, runtime state, plugin options).
 */

export const PORTABLE_SETTING_NAMES = [
	"emdash:locale",
	"emdash:site_tagline",
	"emdash:site_title",
	"site:dateFormat",
	"site:favicon",
	"site:logo",
	"site:postsPerPage",
	"site:seo",
	"site:social",
	"site:tagline",
	"site:timezone",
	"site:title",
] as const;

export type PortableSettingName = (typeof PORTABLE_SETTING_NAMES)[number];

const PORTABLE_SETTINGS: ReadonlySet<string> = new Set(PORTABLE_SETTING_NAMES);

const TARGET_LOCAL_SETTING_NAMES: ReadonlySet<string> = new Set([
	"site:url",
	"emdash:site_url",
	"emdash:site_id",
]);

const TARGET_LOCAL_SETTING_PREFIXES = ["emdash:setup_", "emdash:backups"] as const;

/** Settings whose value is a plan decision rather than always taken from the package. */
export const DECIDED_SETTING_NAMES = {
	title: ["site:title", "emdash:site_title"],
	tagline: ["site:tagline", "emdash:site_tagline"],
} as const satisfies Record<string, readonly PortableSettingName[]>;

/** Options the importer resets after writing settings. */
export const POST_IMPORT_OPTION_RESETS = {
	bumpVersion: ["byline_fields_version"],
	delete: ["_redirect_loop_ids"],
} as const;

export type SettingClass = "portable" | "targetLocal" | "excluded";

export function isPortableSettingName(name: string): name is PortableSettingName {
	return PORTABLE_SETTINGS.has(name);
}

export function classifySetting(name: string): SettingClass {
	if (PORTABLE_SETTINGS.has(name)) return "portable";
	if (TARGET_LOCAL_SETTING_NAMES.has(name)) return "targetLocal";
	if (TARGET_LOCAL_SETTING_PREFIXES.some((prefix) => name.startsWith(prefix))) {
		return "targetLocal";
	}
	return "excluded";
}

/** Settings whose stored value is a `{ mediaId, alt? }` media reference, and where. */
export const SETTING_MEDIA_REFERENCE_PATHS: Readonly<
	Partial<Record<PortableSettingName, readonly (readonly string[])[]>>
> = Object.freeze({
	"site:logo": [["mediaId"]],
	"site:favicon": [["mediaId"]],
	"site:seo": [["defaultOgImage", "mediaId"]],
});

/** Media ids referenced by a portable setting's value. */
export function settingMediaIds(name: string, value: unknown): string[] {
	if (!isPortableSettingName(name)) return [];
	const paths = SETTING_MEDIA_REFERENCE_PATHS[name];
	if (!paths) return [];
	const ids: string[] = [];
	for (const path of paths) {
		let current: unknown = value;
		for (const segment of path) {
			current =
				current !== null &&
				typeof current === "object" &&
				!Array.isArray(current) &&
				Object.hasOwn(current, segment)
					? Reflect.get(current, segment)
					: undefined;
		}
		if (typeof current === "string" && current.length > 0) ids.push(current);
	}
	return ids;
}
