import { describe, expect, test } from "vitest";

import { shouldAnnounceUnlinkedMerge, shouldSkipContributor } from "../src/index.js";

describe("contributor filtering", () => {
	test("skips bot accounts even when their login does not end in [bot]", () => {
		expect(shouldSkipContributor({ id: 1, login: "automation", type: "Bot" }, "maintainer")).toBe(
			true,
		);
	});

	test("also skips the repository owner and conventional bot logins", () => {
		expect(shouldSkipContributor({ id: 1, login: "maintainer" }, "maintainer")).toBe(true);
		expect(shouldSkipContributor({ id: 2, login: "dependabot[bot]" }, "maintainer")).toBe(true);
		expect(shouldSkipContributor({ id: 3, login: "contributor", type: "User" }, "maintainer")).toBe(
			false,
		);
	});
});

describe("unlinked merge announcements", () => {
	test("suppresses a webhook retry for the PR that created the invitation", () => {
		expect(
			shouldAnnounceUnlinkedMerge(
				{
					invited: false,
					record: {
						githubId: 1,
						githubLogin: "contributor",
						prNumber: 42,
						invitedAt: "2026-09-25T00:00:00.000Z",
					},
				},
				42,
			),
		).toBe(false);
	});

	test("announces later PRs and a newly created invitation", () => {
		expect(
			shouldAnnounceUnlinkedMerge(
				{
					invited: false,
					record: {
						githubId: 1,
						githubLogin: "contributor",
						prNumber: 42,
						invitedAt: "2026-09-25T00:00:00.000Z",
					},
				},
				43,
			),
		).toBe(true);
		expect(shouldAnnounceUnlinkedMerge({ invited: true }, 42)).toBe(true);
	});

	test("suppresses an announcement when the contributor linked during processing", () => {
		expect(shouldAnnounceUnlinkedMerge({ invited: false }, 42)).toBe(false);
	});
});
