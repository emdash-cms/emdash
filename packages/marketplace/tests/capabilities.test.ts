import { describe, expect, it } from "vitest";

import { createPluginSchema, manifestSchema } from "../src/routes/author.js";

const COMMENT_CAPABILITIES = ["comments:read", "comments:moderate"] as const;

describe("marketplace plugin capability validation", () => {
	it.each(COMMENT_CAPABILITIES)("accepts %s during plugin registration", (capability) => {
		expect(
			createPluginSchema.safeParse({
				id: "comment-shield",
				name: "Comment Shield",
				capabilities: [capability],
			}).success,
		).toBe(true);
	});

	it.each(COMMENT_CAPABILITIES)("accepts %s in uploaded version manifests", (capability) => {
		expect(
			manifestSchema.safeParse({
				id: "comment-shield",
				version: "1.0.0",
				capabilities: [capability],
			}).success,
		).toBe(true);
	});
});
