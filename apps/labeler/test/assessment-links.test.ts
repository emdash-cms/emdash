import { describe, expect, it } from "vitest";

import type { ModerationLinkField } from "../src/assessment/canonical.js";
import { checkModerationLink } from "../src/assessment/links.js";

function issues(url: string, usage: ModerationLinkField["usage"] = "markdown") {
	return checkModerationLink({ ref: "profile.sections.description.links[0]", url, usage }).issues;
}

describe("checkModerationLink", () => {
	it.each([
		"./email.md",
		"../CHANGELOG.md",
		"/docs/setup",
		"#limits-worth-knowing",
		"?tab=install",
		"http://www.bing.com",
		"https://github.com/emdash-cms/emdash",
		"mailto:security@example.com",
	])("accepts the ordinary markdown link %s", (url) => {
		expect(issues(url)).toEqual([]);
	});

	it.each(["author", "security", "repository"] as const)("accepts an http %s link", (usage) => {
		expect(issues("http://www.example.com", usage)).toEqual([]);
	});

	it.each([
		["javascript:alert(1)", "unsupported-scheme"],
		["data:text/html,hi", "unsupported-scheme"],
		["https://user:secret@example.com", "embedded-credentials"],
		["//user:secret@example.com", "embedded-credentials"],
		["https://exаmple.com", "unicode-host"],
		["//exаmple.com/login", "unicode-host"],
		["/\\exаmple.com/login", "unicode-host"],
		["https://example.com/\u0000", "control-character"],
		["./docs\u0007", "control-character"],
	])("still flags %s", (url, issue) => {
		expect(issues(url)).toContain(issue);
	});

	it("rejects a relative link outside markdown", () => {
		expect(issues("./email.md", "author")).toEqual(["invalid-url"]);
	});
});
