import { describe, expect, it } from "vitest";

import { createPluginSchema, manifestSchema } from "../src/routes/author.js";

describe("marketplace taxonomy write capability", () => {
	it("accepts taxonomy write during plugin registration", () => {
		expect(
			createPluginSchema.safeParse({
				id: "taxonomy-sync",
				name: "Taxonomy sync",
				capabilities: ["taxonomies:write"],
			}).success,
		).toBe(true);
	});

	it("accepts taxonomy write in a published bundle manifest", () => {
		expect(
			manifestSchema.safeParse({
				id: "taxonomy-sync",
				version: "1.0.0",
				capabilities: ["taxonomies:read", "taxonomies:write"],
			}).success,
		).toBe(true);
	});
});
