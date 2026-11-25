/**
 * Validation for stored values that a component writes into an inline `style`
 * attribute. Content fields are not constrained when they are saved, so a
 * value is only usable as CSS once it matches one of these shapes; anything
 * else could set properties beyond the one it is written for.
 */

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?`;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Hyphens and digits are allowed so imported preset names such as `vivid-red` or `accent-1`
// keep rendering as before.
const KEYWORD_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i;
// Function arguments never contain parentheses other than a bare `var(--name)`, so a value
// cannot close its function early or nest `url()`.
const COLOR_FUNCTION_PATTERN =
	/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?:[a-z0-9 .,%/+-]|var\(--[a-z0-9_-]+\))+\)$/i;
const MATH_FUNCTION_PATTERN = /^(?:calc|min|max|clamp)\([a-z0-9 .,%*/+-]+\)$/i;
const LENGTH_PATTERN = new RegExp(String.raw`^(?:0|${NUMBER}(?:[a-z]{1,5}|%))$`, "i");
const NUMBER_PATTERN = new RegExp(`^${NUMBER}$`, "i");
const PERCENTAGE_PATTERN = new RegExp(`^${NUMBER}%$`, "i");
const CUSTOM_PROPERTY_PATTERN = /^var\(\s*--[a-z0-9_-]+\s*(?:,\s*(.+?)\s*)?\)$/i;

/** Accepts `var(--name)`, or `var(--name, fallback)` when the fallback itself passes `check`. */
function isCustomProperty(value: string, check: (fallback: string) => boolean): boolean {
	const match = CUSTOM_PROPERTY_PATTERN.exec(value);
	if (!match) return false;
	const fallback = match[1];
	return fallback === undefined || check(fallback);
}

function isColor(value: string): boolean {
	return (
		HEX_COLOR_PATTERN.test(value) ||
		KEYWORD_PATTERN.test(value) ||
		COLOR_FUNCTION_PATTERN.test(value) ||
		isCustomProperty(value, isColor)
	);
}

function isLength(value: string): boolean {
	return (
		LENGTH_PATTERN.test(value) ||
		KEYWORD_PATTERN.test(value) ||
		MATH_FUNCTION_PATTERN.test(value) ||
		isCustomProperty(value, isLength)
	);
}

/**
 * Returns the value when it is a single CSS color (hex, a keyword such as
 * `rebeccapurple` or `transparent`, a color function, or a `var()` reference),
 * otherwise `undefined`.
 */
export function cssColor(value: unknown): string | undefined {
	return typeof value === "string" && isColor(value) ? value : undefined;
}

/**
 * Returns the value when it is a single CSS size: a length or percentage such
 * as `300px` or `33.33%`, a keyword such as `auto`, a `calc()`, `min()`,
 * `max()` or `clamp()` of numbers and units, or a `var()` reference. Otherwise
 * `undefined`.
 */
export function cssLength(value: unknown): string | undefined {
	return typeof value === "string" && isLength(value) ? value : undefined;
}

/**
 * Returns an opacity between 0 and 1 from a number, a numeric string or a
 * percentage string, clamped as CSS would clamp it, otherwise `undefined`.
 */
export function cssOpacity(value: unknown): number | undefined {
	let number = Number.NaN;
	if (typeof value === "number") {
		number = value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (NUMBER_PATTERN.test(trimmed)) number = Number(trimmed);
		else if (PERCENTAGE_PATTERN.test(trimmed)) number = Number(trimmed.slice(0, -1)) / 100;
	}
	return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined;
}
