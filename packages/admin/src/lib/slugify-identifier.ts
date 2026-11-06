const IDENTIFIER_MAX_LENGTH = 63;

const SPECIAL_REPLACEMENTS = new Map<string, string>([
	// German umlauts and eszett, spelled out the way German does.
	["ä", "ae"],
	["ö", "oe"],
	["ü", "ue"],
	["ß", "ss"],
	["Ä", "Ae"],
	["Ö", "Oe"],
	["Ü", "Ue"],
	["ẞ", "Ss"],
	// A small, stable table for a few common ligatures and special letters.
	["æ", "ae"],
	["œ", "oe"],
	["ø", "oe"],
	["ł", "l"],
	["Æ", "Ae"],
	["Œ", "Oe"],
	["Ø", "Oe"],
	["Ł", "L"],
]);

const NON_IDENTIFIER_CHARACTERS = /[^a-z0-9]+/g;
const LEADING_TRAILING_UNDERSCORES = /^_+|_+$/g;
const COMBINING_MARKS = /\p{Mn}/gu;
const LEADING_LETTER_PATTERN = /^[a-z]/;

/**
 * Convert a human-readable label into a database-style identifier slug.
 *
 * NFC normalization keeps canonically equivalent labels consistent through
 * the explicit ligature/umlaut expansions. NFKD then separates accents so
 * identifiers contain only ASCII letters, digits, and underscores.
 *
 * If the result is empty or would start with a digit, the function returns an
 * empty string so callers can ask the user for a slug instead of creating an
 * invalid one.
 */
export function slugifyIdentifier(value: string): string {
	let result = value.trim().normalize("NFC");

	for (const [from, to] of SPECIAL_REPLACEMENTS) {
		result = result.split(from).join(to);
	}

	result = result.toLowerCase().normalize("NFKD").replace(COMBINING_MARKS, "");
	result = result.replace(NON_IDENTIFIER_CHARACTERS, "_").replace(LEADING_TRAILING_UNDERSCORES, "");

	if (!result || !LEADING_LETTER_PATTERN.test(result)) {
		return "";
	}

	if (result.length > IDENTIFIER_MAX_LENGTH) {
		result = result.slice(0, IDENTIFIER_MAX_LENGTH).replace(LEADING_TRAILING_UNDERSCORES, "");
	}

	return result;
}
