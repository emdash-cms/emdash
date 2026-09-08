import { describe, expect, it } from "vitest";

import { applyLocale, i18n } from "./i18n.js";

describe("runtime message compilation", () => {
	it("interpolates fallback messages used by the production UI", () => {
		applyLocale("en");
		expect(
			i18n._(
				"publisher.signedInAs",
				{ handle: "@publisher.example.com" },
				{ message: "Signed in as {handle}" },
			),
		).toBe("Signed in as @publisher.example.com");
		expect(
			i18n._(
				"operator.archive.result",
				{ kind: "audit", page: 3 },
				{ message: "Stored {kind} page {page}." },
			),
		).toBe("Stored audit page 3.");
	});
});
