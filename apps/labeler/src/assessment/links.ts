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

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const IN_PAGE_HOST = "in-page.invalid";

export function checkModerationLink(link: ModerationLinkField): CheckedModerationLink {
	const issues: DisplayUrlIssue[] = [];
	if (containsControlCharacter(link.url)) issues.push("control-character");
	const relative = link.usage === "markdown" && !SCHEME_RE.test(link.url);
	let parsed: URL;
	try {
		parsed = relative ? new URL(link.url, `https://${IN_PAGE_HOST}/`) : new URL(link.url);
	} catch {
		return { ...link, issues: [...issues, "invalid-url"] };
	}
	// A relative or anchor link stays on the page that renders it; one that
	// resolves to another host, such as `//host/path`, is checked as outbound.
	if (relative && parsed.host === IN_PAGE_HOST) return { ...link, issues };
	const supportedSchemes =
		link.usage === "repository"
			? ["https:", "http:", "at:"]
			: link.usage === "markdown"
				? ["https:", "http:", "mailto:"]
				: ["https:", "http:"];
	if (!supportedSchemes.includes(parsed.protocol)) issues.push("unsupported-scheme");
	if (parsed.username !== "" || parsed.password !== "") issues.push("embedded-credentials");
	if (hasUnicodeAuthority(link.url) || (relative && hasPunycodeLabel(parsed.hostname))) {
		issues.push("unicode-host");
	}
	return { ...link, normalizedUrl: parsed.toString(), issues };
}

function hasPunycodeLabel(hostname: string): boolean {
	return hostname.split(".").some((label) => label.startsWith("xn--"));
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
