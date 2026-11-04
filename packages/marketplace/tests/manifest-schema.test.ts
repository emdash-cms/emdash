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

	it("preserves raw route contracts and MCP declarations", () => {
		const value = manifest({
			routes: [
				{
					name: "download",
					methods: ["GET"],
					request: { body: "none", headers: ["accept"] },
					response: "raw",
					permission: "content:read",
				},
				{
					name: "repair",
					methods: ["POST"],
					request: { body: "json", maxBytes: 1024 },
					response: "json",
					permission: "content:edit_own",
				},
			],
			mcp: {
				tools: [
					{
						name: "repair",
						description: "Repair content",
						route: "repair",
						permission: "content:edit_own",
						destructive: true,
						inputSchema: { type: "object" },
						outputSchema: { type: "object" },
					},
				],
			},
		});

		const result = manifestSchema.parse(value);
		expect(result.routes).toEqual(value.routes);
		expect(result.mcp).toEqual(value.mcp);
	});

	it("rejects duplicate route names across legacy and structured declarations", () => {
		expect(
			manifestSchema.safeParse(
				manifest({
					routes: ["admin", { name: "admin", public: true }],
					admin: {},
				}),
			).success,
		).toBe(false);
	});

	it.each([
		{ label: "GET-only", route: { methods: ["GET"] } },
		{ label: "form-data request", route: { request: { body: "form-data" } } },
		{ label: "raw response", route: { response: "raw" } },
	])("rejects an incompatible editor route contract: $label", ({ route }) => {
		expect(
			manifestSchema.safeParse(
				manifest({
					routes: [{ name: "repair", permission: "content:edit_own", ...route }],
				}),
			).success,
		).toBe(false);
	});

	it.each([
		{ label: "GET-only", route: { methods: ["GET"] } },
		{ label: "form-data request", route: { request: { body: "form-data" } } },
		{ label: "raw response", route: { response: "raw" } },
	])("rejects an incompatible Block Kit admin route contract: $label", ({ route }) => {
		expect(
			manifestSchema.safeParse(
				manifest({
					routes: [{ name: "admin", ...route }],
					admin: { pages: [{ path: "/settings", label: "Settings" }] },
				}),
			).success,
		).toBe(false);
	});

	it.each([
		{ label: "GET-only", route: { methods: ["GET"] } },
		{ label: "form-data request", route: { request: { body: "form-data" } } },
		{ label: "raw response", route: { response: "raw" } },
	])("rejects an incompatible MCP route contract: $label", ({ route }) => {
		expect(
			manifestSchema.safeParse(
				manifest({
					routes: [{ name: "repair", permission: "content:edit_own", ...route }],
					mcp: {
						tools: [
							{
								name: "repair",
								description: "Repair content",
								route: "repair",
								permission: "content:edit_own",
								destructive: true,
								inputSchema: { type: "object" },
							},
						],
					},
				}),
			).success,
		).toBe(false);
	});
});
