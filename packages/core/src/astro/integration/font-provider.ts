/**
 * EmDash Noto Sans font provider
 *
 * A custom Astro font provider that wraps Google Fonts to resolve
 * multiple Noto Sans families (Latin, Arabic, JP, etc.) under a
 * single logical font entry. This lets all @font-face blocks share
 * the same font-family name, so the browser picks the right file
 * per character via unicode-range.
 *
 * Without this, registering "Noto Sans" and "Noto Sans Arabic" as
 * separate font entries on the same cssVariable triggers an Astro
 * warning and the last entry overwrites the first.
 */

import { fontProviders } from "astro/config";

/**
 * All subset names used by Google Fonts CSS responses.
 * Passed when resolving extra script families so the unifont
 * provider doesn't filter out any faces.
 */
const ALL_GOOGLE_SUBSETS = [
	"arabic",
	"armenian",
	"bengali",
	"chinese-simplified",
	"chinese-traditional",
	"chinese-hongkong",
	"cyrillic",
	"cyrillic-ext",
	"devanagari",
	"ethiopic",
	"georgian",
	"greek",
	"greek-ext",
	"gujarati",
	"gurmukhi",
	"hebrew",
	"japanese",
	"kannada",
	"khmer",
	"korean",
	"lao",
	"latin",
	"latin-ext",
	"malayalam",
	"math",
	"myanmar",
	"oriya",
	"sinhala",
	"symbols",
	"tamil",
	"telugu",
	"thai",
	"tibetan",
	"vietnamese",
];

/**
 * Known Noto Sans script families on Google Fonts.
 * Maps user-friendly script names to Google Fonts family names.
 */
const NOTO_SCRIPT_FAMILIES: Record<string, string> = {
	arabic: "Noto Sans Arabic",
	armenian: "Noto Sans Armenian",
	bengali: "Noto Sans Bengali",
	"chinese-simplified": "Noto Sans SC",
	"chinese-traditional": "Noto Sans TC",
	"chinese-hongkong": "Noto Sans HK",
	devanagari: "Noto Sans Devanagari",
	ethiopic: "Noto Sans Ethiopic",
	georgian: "Noto Sans Georgian",
	gujarati: "Noto Sans Gujarati",
	gurmukhi: "Noto Sans Gurmukhi",
	hebrew: "Noto Sans Hebrew",
	japanese: "Noto Sans JP",
	kannada: "Noto Sans Kannada",
	khmer: "Noto Sans Khmer",
	korean: "Noto Sans KR",
	lao: "Noto Sans Lao",
	malayalam: "Noto Sans Malayalam",
	myanmar: "Noto Sans Myanmar",
	oriya: "Noto Sans Oriya",
	sinhala: "Noto Sans Sinhala",
	tamil: "Noto Sans Tamil",
	telugu: "Noto Sans Telugu",
	thai: "Noto Sans Thai",
	tibetan: "Noto Sans Tibetan",
};

export interface NotoSansProviderOptions {
	/**
	 * Additional Noto Sans script families to include.
	 * Use script names like "arabic", "japanese", "chinese-simplified".
	 *
	 * @see {@link NOTO_SCRIPT_FAMILIES} for the full list of supported scripts.
	 */
	scripts?: string[];
}

// Use ReturnType to get the provider type without importing it directly.
// The Astro FontProvider type is not part of the public API surface.
type GoogleProvider = ReturnType<typeof fontProviders.google>;

/**
 * Create a font provider that resolves Noto Sans plus additional
 * script-specific Noto families from Google Fonts, all under one
 * font-family name.
 */
export function notoSans(options?: NotoSansProviderOptions): GoogleProvider {
	// Create a single Google provider instance to share initialization
	const googleProvider = fontProviders.google();

	return {
		name: "emdash-noto",
		async init(context) {
			await googleProvider.init?.(context);
		},
		async resolveFont(resolveFontOptions) {
			const { weights, styles, formats } = resolveFontOptions;

			// Resolve the base Noto Sans (Latin, Cyrillic, Greek, etc.)
			const base = await googleProvider.resolveFont(resolveFontOptions);
			const baseFonts = base?.fonts ?? [];

			if (!options?.scripts?.length) {
				return base;
			}

			// Collect subset names already covered by the base font so we
			// can filter out duplicate faces from extra script families.
			// e.g. Noto Sans Arabic includes latin/latin-ext faces that
			// would otherwise override the base Noto Sans latin faces.
			const baseSubsets = new Set(baseFonts.map((f) => f.meta?.subset).filter(Boolean));

			// Resolve additional script families
			const extraFonts = await Promise.all(
				options.scripts.map(async (script) => {
					const family = NOTO_SCRIPT_FAMILIES[script];
					if (!family) {
						// Silently skip subset names that are already covered
						// by the base Noto Sans font (latin, cyrillic, etc.)
						if (ALL_GOOGLE_SUBSETS.includes(script)) {
							return undefined;
						}
						console.warn(
							`[emdash] Unknown Noto Sans script "${script}". ` +
								`Available: ${Object.keys(NOTO_SCRIPT_FAMILIES).join(", ")}`,
						);
						return undefined;
					}
					return googleProvider.resolveFont({
						familyName: family,
						weights,
						styles,
						// Pass all known subset names so the unifont provider
						// doesn't filter out any faces. Each script family
						// only returns faces for its own subsets anyway.
						subsets: ALL_GOOGLE_SUBSETS,
						formats,
						options: undefined,
					});
				}),
			);

			// Merge, dropping faces from extra fonts that duplicate base subsets
			const extraFaces = extraFonts.flatMap((r) =>
				(r?.fonts ?? []).filter((f) => !f.meta?.subset || !baseSubsets.has(f.meta.subset)),
			);

			return {
				fonts: [...baseFonts, ...extraFaces],
			};
		},
	};
}

/** Get the list of available Noto Sans script names */
export function getAvailableNotoScripts(): string[] {
	return Object.keys(NOTO_SCRIPT_FAMILIES);
}
