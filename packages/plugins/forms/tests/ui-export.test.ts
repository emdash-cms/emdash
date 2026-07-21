import { describe, expect, it } from "vitest";

describe("standalone form UI export", () => {
	it("resolves the documented package entrypoint", () => {
		expect(import.meta.resolve("@emdash-cms/plugin-forms/ui")).toMatch(/\/src\/astro\/ui\.ts$/);
	});
});
