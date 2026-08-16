const URL_PARAM_PATTERN = /\{(\w+)\}/g;
const REGEX_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;
const INVALID_LITERAL_PATTERN = /[{}]/;

function escapeRegex(literal: string): string {
	return literal.replace(REGEX_SPECIAL_CHARACTERS, "\\$&");
}

export function compileUrlPattern(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	let regexSource = "";
	let previousIndex = 0;

	for (const match of pattern.matchAll(URL_PARAM_PATTERN)) {
		const matchIndex = match.index;
		const literal = pattern.slice(previousIndex, matchIndex);
		if (INVALID_LITERAL_PATTERN.test(literal)) throw new Error("Invalid URL pattern placeholder");
		regexSource += escapeRegex(literal);

		const name = match[1];
		paramNames.push(name);
		regexSource += "([^/]+)";
		previousIndex = matchIndex + match[0].length;
	}

	const trailingLiteral = pattern.slice(previousIndex);
	if (INVALID_LITERAL_PATTERN.test(trailingLiteral)) {
		throw new Error("Invalid URL pattern placeholder");
	}
	regexSource += escapeRegex(trailingLiteral);

	return { regex: new RegExp(`^${regexSource}$`), paramNames };
}
