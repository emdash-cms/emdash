import { describe, expect, it } from "vitest";

import { manifestSchema } from "../src/routes/author.js";

describe("marketplace manifest schema", () => {
	it("accepts email:status hooks in string and object form", () => {
		expect(() =>
			manifestSchema.parse({
				id: "test-plugin",
				version: "1.2.3",
				capabilities: [],
				hooks: ["email:status", { name: "email:status", exclusive: true }],
			}),
		).not.toThrow();
	});
});
