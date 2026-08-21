import { describe, expect, it } from "vitest";

import emdash from "../../../../src/astro/integration/index.js";

describe("marketplace without a sandbox runner", () => {
	it("allows themes to remain available when sandboxed plugins are disabled", () => {
		expect(() =>
			emdash({
				marketplace: "https://marketplace.emdashcms.com",
				sandboxRunner: undefined,
			}),
		).not.toThrow();
	});
});
