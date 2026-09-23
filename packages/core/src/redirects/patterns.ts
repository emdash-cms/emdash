/**
 * URL pattern matching for redirects.
 *
 * Uses Astro's route syntax: [param] for named segments, [...rest] for catch-all.
 * Compiles patterns to safe regexes -- no user-supplied regex, no ReDoS risk.
 *
 * @example
 * ```ts
 * const compiled = compilePattern("/old-blog/[...path]");
 * const match = matchPattern(compiled, "/old-blog/2024/01/post");
 * // match = { path: "2024/01/post" }
 *
 * interpolateDestination("/blog/[...path]", match);
 * // "/blog/2024/01/post"
 * ```
 */

/** Matches [paramName] placeholders */
const PARAM_PATTERN = /\[(\w+)\]/g;

/** Matches [...splatName] placeholders */
const SPLAT_PATTERN = /\[\.\.\.(\w+)\]/g;

/** Combined pattern for validation: matches both [param] and [...splat] */
const ANY_PLACEHOLDER = /\[(?:\.\.\.)?(\w+)\]/g;

/** Nested brackets check: [foo[ */
const NESTED_BRACKETS = /\[[^\]]*\[/;

/** Empty brackets: [] */
const EMPTY_BRACKETS = /\[\]/;

/** Count open brackets */
const OPEN_BRACKET = /\[/g;

/** Count close brackets */
const CLOSE_BRACKET = /\]/g;

/** A [param] or [...splat] placeholder, capturing the splat marker and the name */
const PLACEHOLDER_TOKEN = /\[(\.\.\.)?(\w+)\]/g;

/** Escape regex-special characters in literal parts */
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export interface CompiledPattern {
	regex: RegExp;
	paramNames: string[];
	source: string;
}

/**
 * Returns true if a source string contains [param] or [...splat] placeholders.
 */
export function isPattern(source: string): boolean {
	// Use match() instead of test() to avoid lastIndex issues with the global regex
	return source.match(ANY_PLACEHOLDER) !== null;
}

/**
 * Validate that a pattern string is well-formed.
 * Returns null if valid, or an error message if invalid.
 */
export function validatePattern(source: string): string | null {
	if (!source.startsWith("/")) {
		return "Pattern must start with /";
	}

	// Check for nested brackets
	if (NESTED_BRACKETS.test(source)) {
		return "Nested brackets are not allowed";
	}

	// Check for empty brackets
	if (EMPTY_BRACKETS.test(source)) {
		return "Empty brackets are not allowed";
	}

	// Check for unmatched brackets
	const openCount = (source.match(OPEN_BRACKET) ?? []).length;
	const closeCount = (source.match(CLOSE_BRACKET) ?? []).length;
	if (openCount !== closeCount) {
		return "Unmatched brackets";
	}

	// Check that [...splat] is only in the last segment
	const segments = source.split("/").filter(Boolean);
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (SPLAT_PATTERN.test(segment) && i !== segments.length - 1) {
			SPLAT_PATTERN.lastIndex = 0;
			return "Catch-all [...param] must be in the last segment";
		}
		SPLAT_PATTERN.lastIndex = 0;
	}

	// Check that a segment is either all literal or a single placeholder
	for (const segment of segments) {
		const placeholders = segment.match(ANY_PLACEHOLDER);
		if (placeholders && placeholders.length > 1) {
			return "Each segment can contain at most one placeholder";
		}
		if (placeholders && placeholders[0] !== segment) {
			return "A placeholder must be the entire segment, not mixed with literal text";
		}
	}

	// Check for duplicate param names
	const names: string[] = [];
	for (const m of source.matchAll(ANY_PLACEHOLDER)) {
		const name = m[1];
		if (names.includes(name)) {
			return `Duplicate parameter name: ${name}`;
		}
		names.push(name);
	}

	return null;
}

/**
 * Validate that all placeholders in a destination exist in the source.
 * Returns null if valid, or an error message if invalid.
 */
export function validateDestinationParams(source: string, destination: string): string | null {
	const sourceNames = new Set<string>();
	for (const m of source.matchAll(ANY_PLACEHOLDER)) {
		sourceNames.add(m[1]);
	}

	for (const m of destination.matchAll(ANY_PLACEHOLDER)) {
		const name = m[1];
		if (!sourceNames.has(name)) {
			return `Destination references [${name}] which is not captured in the source pattern`;
		}
	}

	return null;
}

/**
 * Compile a URL pattern into a regex for matching.
 *
 * - `[param]` matches a single path segment (`[^/]+`)
 * - `[...rest]` matches one or more remaining segments (`.+`)
 */
export function compilePattern(source: string): CompiledPattern {
	const paramNames: string[] = [];
	let regexStr = "";
	let literalStart = 0;
	for (const match of source.matchAll(PLACEHOLDER_TOKEN)) {
		regexStr += escapeLiteral(source.slice(literalStart, match.index));
		paramNames.push(match[2]);
		regexStr += match[1] ? "(.+)" : "([^/]+)";
		literalStart = match.index + match[0].length;
	}
	regexStr += escapeLiteral(source.slice(literalStart));

	return {
		regex: new RegExp(`^${regexStr}$`),
		paramNames,
		source,
	};
}

function escapeLiteral(literal: string): string {
	return literal.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

/**
 * Match a path against a compiled pattern.
 * Returns captured params or null if no match.
 */
export function matchPattern(
	compiled: CompiledPattern,
	path: string,
): Record<string, string> | null {
	const match = path.match(compiled.regex);
	if (!match) return null;

	const params: Record<string, string> = {};
	for (let i = 0; i < compiled.paramNames.length; i++) {
		const value = match[i + 1];
		if (value !== undefined) {
			params[compiled.paramNames[i]] = value;
		}
	}
	return params;
}

/**
 * Interpolate captured params into a destination pattern.
 *
 * @example
 * interpolateDestination("/blog/[...path]", { path: "2024/01/post" })
 * // "/blog/2024/01/post"
 */
export function interpolateDestination(
	destination: string,
	params: Record<string, string>,
): string {
	// Replace [...splat] first
	let result = destination.replace(SPLAT_PATTERN, (_match, name: string) => {
		return params[name] ?? "";
	});

	// Then [param]
	result = result.replace(PARAM_PATTERN, (_match, name: string) => {
		return params[name] ?? "";
	});

	return result;
}
