import type { ModerationLinkField } from "./canonical.js";

export type DisplayUrlIssue =
	| "unsupported-scheme"
	| "embedded-credentials"
	| "control-character"
	| "unicode-host"
	| "invalid-url";

export interface CheckedModerationLink extends ModerationLinkField {
	normalizedUrl?: string;
	issues: readonly DisplayUrlIssue[];
}

export function checkModerationLinks(
	links: readonly ModerationLinkField[],
): CheckedModerationLink[] {
	return links.map(checkModerationLink);
}

export function checkModerationLink(link: ModerationLinkField): CheckedModerationLink {
	const issues: DisplayUrlIssue[] = [];
	if (containsControlCharacter(link.url)) issues.push("control-character");
	let parsed: URL;
	try {
		parsed = new URL(link.url);
	} catch {
		return { ...link, issues: [...issues, "invalid-url"] };
	}
	const supportedSchemes =
		link.usage === "repository"
			? ["https:", "at:"]
			: link.usage === "markdown"
				? ["https:", "mailto:"]
				: ["https:"];
	if (!supportedSchemes.includes(parsed.protocol)) issues.push("unsupported-scheme");
	if (parsed.username !== "" || parsed.password !== "") issues.push("embedded-credentials");
	if (hasUnicodeAuthority(link.url)) issues.push("unicode-host");
	return { ...link, normalizedUrl: parsed.toString(), issues };
}

function hasUnicodeAuthority(value: string): boolean {
	const schemeEnd = value.indexOf(":");
	if (schemeEnd === -1 || value.slice(schemeEnd + 1, schemeEnd + 3) !== "//") return false;
	const authorityStart = schemeEnd + 3;
	const authorityEndCandidates = [
		value.indexOf("/", authorityStart),
		value.indexOf("?", authorityStart),
		value.indexOf("#", authorityStart),
	].filter((index) => index !== -1);
	const authorityEnd =
		authorityEndCandidates.length > 0 ? Math.min(...authorityEndCandidates) : value.length;
	for (const character of value.slice(authorityStart, authorityEnd)) {
		if (character.codePointAt(0)! > 0x7f) return true;
	}
	return false;
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}
