import { describe, expect, it } from "vitest";

import { formatListedDate, profileSections, securityContactHref, sourceLabel } from "./detail.js";

describe("plugin detail helpers", () => {
	it("lists extra sections in profile order with unique, fragment-safe ids", () => {
		const sections = profileSections({
			$type: "com.emdashcms.experimental.package.profile#sections",
			description: "Shown as the overview.",
			faq: "Questions",
			empty: "   ",
			"AI agents": "Tools",
			ai_agents: "More tools",
			使い方: "Usage",
		});

		expect(sections.map(({ id, title }) => ({ id, title }))).toEqual([
			{ id: "section-faq", title: "FAQ" },
			{ id: "section-ai-agents", title: "AI Agents" },
			{ id: "section-ai-agents-2", title: "Ai Agents" },
			{ id: "section-4", title: "使い方" },
		]);
	});

	it("never gives a section the id of another section's heading", () => {
		const sections = profileSections({
			faq: "A",
			"faq title": "B",
			"notes title": "C",
			notes: "D",
		});
		const ids = sections.flatMap(({ id, titleId }) => [id, titleId]);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it("links the first security contact that is safe to open", () => {
		expect(
			securityContactHref([
				{ url: "javascript:alert(1)" },
				{ url: "http://example.com/security" },
				{ email: "security@example.com" },
			]),
		).toBe("mailto:security@example.com");
		expect(securityContactHref([{ url: "https://example.com/security" }])).toBe(
			"https://example.com/security",
		);
		expect(securityContactHref([{ email: "not an email" }, { email: "a@b.c?cc=x" }])).toBe(
			undefined,
		);
	});

	it("shortens a repository URL to its host and path", () => {
		expect(sourceLabel("https://github.com/owner/repo.git/")).toBe("github.com/owner/repo");
	});

	it("formats the listing date in UTC", () => {
		expect(formatListedDate("2026-09-01T23:30:00-05:00")).toBe("Sep 2, 2026");
		expect(formatListedDate("not a date")).toBeUndefined();
	});
});
