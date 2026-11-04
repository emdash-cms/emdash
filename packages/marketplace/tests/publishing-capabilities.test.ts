import { describe, expect, it } from "vitest";

import { createPluginSchema, manifestSchema } from "../src/routes/author.js";

describe("marketplace media capability publication", () => {
	const capabilities = ["media:bytes:read", "media:metadata:write"] as const;

	it.each(capabilities)("accepts %s during registration and bundle publication", (capability) => {
		const registration = createPluginSchema.safeParse({
			id: "media-tools",
			name: "Media tools",
			capabilities: [capability],
		});
		const publication = manifestSchema.safeParse({
			id: "media-tools",
			version: "1.0.0",
			capabilities: [capability],
		});

		expect(registration.success).toBe(true);
		expect(publication.success).toBe(true);
	});
});
