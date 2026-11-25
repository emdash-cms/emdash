/**
 * Validation for stored values that a component writes into an inline `style`
 * attribute. Content fields are not constrained when they are saved, so a
 * value is only usable as CSS once it matches one of these shapes; anything
 * else could end its declaration with `;` and add declarations of its own.
 */

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Hyphens are allowed so imported preset names such as `vivid-red` keep rendering as before.
const KEYWORD_PATTERN = /^[a-z]+(?:-[a-z]+)*$/i;
// The arguments exclude parentheses, so `var()`, `url()` and `calc()` cannot nest.
const COLOR_FUNCTION_PATTERN =
	/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([a-z0-9 .,%/+-]+\)$/i;
const LENGTH_PATTERN = /^(?:0|\d+(?:\.\d+)?(?:[a-z]{1,5}|%))$/i;

/**
 * Returns the value when it is a single CSS color (hex, a keyword such as
 * `rebeccapurple` or `transparent`, or a color function), otherwise `undefined`.
 */
export function cssColor(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return HEX_COLOR_PATTERN.test(value) ||
		KEYWORD_PATTERN.test(value) ||
		COLOR_FUNCTION_PATTERN.test(value)
		? value
		: undefined;
}

/**
 * Returns the value when it is a single non-negative CSS length or percentage
 * such as `300px`, `50vh` or `33.33%`, otherwise `undefined`.
 */
export function cssLength(value: unknown): string | undefined {
	return typeof value === "string" && LENGTH_PATTERN.test(value) ? value : undefined;
}
