import { safeExternalUrl } from "./registry.js";

export interface ProfileSection {
	key: string;
	id: string;
	titleId: string;
	title: string;
	markdown: string;
}

const SECTION_TITLES: Record<string, string> = {
	installation: "Installation",
	faq: "FAQ",
	changelog: "Changelog",
	security: "Security",
};

export function sectionTitle(key: string): string {
	const known = SECTION_TITLES[key.toLowerCase()];
	if (known) return known;
	const words = key.replace(/[-_]+/g, " ").trim();
	return words
		? words.replace(
				/(^|\s)(\S)/g,
				(_match, space: string, letter: string) => space + letter.toUpperCase(),
			)
		: key;
}

/**
 * The publisher's extra Markdown sections, in profile order, without the
 * description (shown as the overview). Section and heading ids are unique on
 * the page and stay ASCII so they work as URL fragments.
 */
export function profileSections(sections: Record<string, unknown> | undefined): ProfileSection[] {
	const used = new Set<string>();
	const result: ProfileSection[] = [];
	for (const [key, markdown] of Object.entries(sections ?? {})) {
		if (key === "$type" || key === "description") continue;
		if (typeof markdown !== "string" || markdown.trim().length === 0) continue;
		const slug = key
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const base = `section-${slug || result.length + 1}`;
		let id = base;
		for (let suffix = 2; used.has(id) || used.has(`${id}-title`); suffix++) {
			id = `${base}-${suffix}`;
		}
		const titleId = `${id}-title`;
		used.add(id).add(titleId);
		result.push({ key, id, titleId, title: sectionTitle(key), markdown });
	}
	return result;
}

const EMAIL_PATTERN = /^[^\s@/?#]+@[^\s@/?#]+$/;

/** A link for the first security contact that has a usable HTTPS URL or email address. */
export function securityContactHref(
	contacts: ReadonlyArray<{ url?: string; email?: string }> | undefined,
): string | undefined {
	for (const contact of contacts ?? []) {
		const url = safeExternalUrl(contact.url);
		if (url) return url;
		const email = contact.email?.trim();
		if (email && EMAIL_PATTERN.test(email)) return `mailto:${email}`;
	}
	return undefined;
}

const REPOSITORY_PATH_SUFFIX = /(?:\.git)?\/*$/;

/** `github.com/owner/repo` for a source link. */
export function sourceLabel(url: string): string {
	const parsed = new URL(url);
	const path = parsed.pathname.replace(REPOSITORY_PATH_SUFFIX, "");
	return `${parsed.host}${path}`;
}

/** "Sep 3, 2026", in UTC so the server and every visitor agree. */
export function formatListedDate(value: string): string | undefined {
	const time = Date.parse(value);
	if (Number.isNaN(time)) return undefined;
	return new Intl.DateTimeFormat("en", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	}).format(time);
}
