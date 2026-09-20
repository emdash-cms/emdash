import { describe, expect, it } from "vitest";

import { manifestSchema } from "../src/routes/author.js";

function manifest(overrides: Record<string, unknown> = {}) {
	return {
		id: "content-guard",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [{ name: "repair", permission: "content:edit_own" }],
		admin: {
			editorActions: [
				{
					id: "repair",
					label: "Repair",
					route: "repair",
					placement: "overflow",
					collections: ["posts"],
				},
			],
		},
		...overrides,
	};
}

describe("marketplace plugin manifest parity", () => {
	it("accepts an editor extension with an authoritative private route permission", () => {
		expect(manifestSchema.safeParse(manifest()).success).toBe(true);
	});

	it("rejects a route permission that core cannot install", () => {
		expect(
			manifestSchema.safeParse(manifest({ routes: [{ name: "repair", permission: "not-real" }] }))
				.success,
		).toBe(false);
	});

	it.each(["toString", "constructor", "__proto__"])(
		"rejects inherited object key %s as a route permission",
		(permission) => {
			expect(
				manifestSchema.safeParse(manifest({ routes: [{ name: "repair", permission }] })).success,
			).toBe(false);
		},
	);

	it("rejects duplicate collection filters that core cannot install", () => {
		const value = manifest();
		value.admin.editorActions[0]!.collections = ["posts", "posts"];
		expect(manifestSchema.safeParse(value).success).toBe(false);
	});
});
