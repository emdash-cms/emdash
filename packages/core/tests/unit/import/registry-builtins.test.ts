import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportSource } from "../../../src/import/types.js";

type Registry = typeof import("../../../src/import/registry.js");

/** A fresh copy of the registry module, with nothing looked up yet. */
async function freshRegistry(): Promise<Registry> {
	vi.resetModules();
	return import("../../../src/import/registry.js");
}

const custom = { id: "custom", requiresFile: true, canProbe: false } as ImportSource;

describe("import source registry", () => {
	let registry: Registry;

	beforeEach(async () => {
		registry = await freshRegistry();
	});

	it("adds the built-in sources on first lookup, in priority order", () => {
		expect(registry.getAllSources().map((s) => s.id)).toEqual([
			"wordpress-plugin",
			"wordpress-rest",
			"wxr",
		]);
	});

	it("finds a built-in source by id", () => {
		expect(registry.getSource("wxr")?.id).toBe("wxr");
	});

	it("adds the built-in sources for file and URL lookups", () => {
		expect(registry.getFileSources().map((s) => s.id)).toContain("wxr");
		expect(registry.getUrlSources().map((s) => s.id)).toContain("wordpress-rest");
	});

	it("puts a source registered first after the built-ins", () => {
		registry.registerSource(custom);
		expect(registry.getAllSources().map((s) => s.id)).toEqual([
			"wordpress-plugin",
			"wordpress-rest",
			"wxr",
			"custom",
		]);
	});

	it("does not add the built-ins back after clearSources", () => {
		registry.getAllSources();
		registry.clearSources();
		expect(registry.getAllSources()).toEqual([]);
		registry.registerSource(custom);
		expect(registry.getAllSources().map((s) => s.id)).toEqual(["custom"]);
	});

	it("stays empty when cleared before any lookup", () => {
		registry.clearSources();
		expect(registry.getSource("wxr")).toBeUndefined();
		expect(registry.getAllSources()).toEqual([]);
	});
});
