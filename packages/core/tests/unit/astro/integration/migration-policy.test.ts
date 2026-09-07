import { describe, expect, it } from "vitest";

import { emdash } from "../../../../src/astro/integration/index.js";

describe("EmDash integration migration policy", () => {
	it("rejects invalid runtime and development modes during integration setup", () => {
		expect(() => emdash({ migrations: { runtime: "later" } as never })).toThrow(
			/migrations\.runtime.*later/,
		);
		expect(() => emdash({ migrations: { runtime: "auto", dev: "later" } as never })).toThrow(
			/migrations\.dev.*later/,
		);
	});
});
