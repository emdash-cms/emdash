import { describe, expect, test } from "vitest";

import { shouldSkipContributor } from "../src/index.js";

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
