/**
 * Maps a Portable Text block's `textAlign` to a WordPress-style class name
 * (`has-text-align-{value}`) for public rendering. Used by the Portable Text
 * `Block` override in `./Block.astro`.
 *
 * `left` is the document default and intentionally does not produce a class —
 * this matches the converter's omit-on-default rule (see
 * `src/content/converters/prosemirror-to-portable-text.ts`) so untouched
 * content stays bytewise identical and renders without an extra class.
 *
 * Related: https://github.com/emdash-cms/emdash/issues/1201
 */

type AlignClassName = "has-text-align-center" | "has-text-align-right" | "has-text-align-justify";

const ALIGN_CLASS_MAP: Record<string, AlignClassName> = {
	center: "has-text-align-center",
	right: "has-text-align-right",
	justify: "has-text-align-justify",
};

/**
 * Returns the CSS class for a textAlign value, or `undefined` when no class
 * should be emitted (default left, missing, or unknown values).
 *
 * Allowlist-only by design: arbitrary strings are rejected so a hand-edited
 * or imported Portable Text block cannot inject attacker-controlled class
 * names into the rendered HTML.
 */
export function textAlignClassName(value: string | undefined): AlignClassName | undefined {
	if (value === undefined) return undefined;
	// `Object.hasOwn` (not `in`) so prototype keys like "toString" or
	// "constructor" can't slip through as valid alignments.
	if (Object.hasOwn(ALIGN_CLASS_MAP, value)) {
		return ALIGN_CLASS_MAP[value];
	}
	return undefined;
}
