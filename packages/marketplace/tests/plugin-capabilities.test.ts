import { describe, expect, it } from "vitest";

import { createPluginSchema, manifestSchema } from "../src/routes/author.js";

const BASE_PLUGIN = {
	id: "publication-policy",
	name: "Publication policy",
};

describe("marketplace plugin capabilities", () => {
	it("accepts publication-policy capability declarations at registration and upload", () => {
		expect(() =>
			createPluginSchema.parse({
				...BASE_PLUGIN,
				capabilities: ["hooks.content-policy:register"],
			}),
		).not.toThrow();

		expect(() =>
			manifestSchema.parse({
				...BASE_PLUGIN,
				version: "1.0.0",
				capabilities: ["hooks.content-policy:register"],
			}),
		).not.toThrow();
	});

	it("still rejects unknown capabilities", () => {
		expect(() =>
			createPluginSchema.parse({
				...BASE_PLUGIN,
				capabilities: ["content:invent"],
			}),
		).toThrow();
	});
});
