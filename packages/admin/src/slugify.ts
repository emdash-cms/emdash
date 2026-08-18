const SEPARATOR_PATTERN = /[\s_]+/gu;
const UNSAFE_CHARACTER_PATTERN = /[^\p{Letter}\p{Number}\p{Mark}-]+/gu;
const MULTIPLE_HYPHENS_PATTERN = /-+/g;
const EDGE_HYPHENS_PATTERN = /^-+|-+$/g;
const TRAILING_HYPHENS_PATTERN = /-+$/g;
const USABLE_CHARACTER_PATTERN = /[\p{Letter}\p{Number}]/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function fallbackSlug(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `untitled-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

function truncateByGrapheme(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (!Number.isFinite(maxLength)) return value;

	let result = "";
	let length = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
		if (length >= Math.floor(maxLength)) break;
		result += segment;
		length++;
	}
	return result.replace(TRAILING_HYPHENS_PATTERN, "");
}

/**
 * Convert text to a browser-safe Unicode URL slug.
 *
 * Text is NFKC-normalized and lowercased; whitespace and underscores become
 * hyphens while Unicode letters, numbers, and combining marks are preserved.
 * The length limit counts grapheme clusters. Inputs without usable characters
 * receive a stable `untitled-*` fallback.
 */
export function slugify(text: string, maxLength = 80): string {
	const normalized = text.normalize("NFKC").toLowerCase();
	const slug = normalized
		.replace(SEPARATOR_PATTERN, "-")
		.replace(UNSAFE_CHARACTER_PATTERN, "")
		.replace(MULTIPLE_HYPHENS_PATTERN, "-")
		.replace(EDGE_HYPHENS_PATTERN, "");
	const value = USABLE_CHARACTER_PATTERN.test(slug) ? slug : fallbackSlug(normalized);
	return truncateByGrapheme(value, maxLength);
}
