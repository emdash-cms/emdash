import type { SeedFile } from "../../../src/seed/types.js";
import { describe, expect, it } from "vitest";

import { resolveAutoSeed } from "../../../src/seed/load.js";

describe("resolveAutoSeed", () => {
	const defaultSeed = { version: 1, collections: [] } as SeedFile;

	it("keeps built-in fallback content disabled", () => {
		const result = resolveAutoSeed(defaultSeed, null);

		expect(result.seed).toEqual(defaultSeed);
		expect(result.includeContent).toBe(false);
	});

	it("includes content from a project-authored seed", () => {
		const userSeed = {
			version: 1,
			collections: [],
			content: { services: [] },
		} as SeedFile;
		const result = resolveAutoSeed(defaultSeed, userSeed);

		expect(result.seed).toEqual(userSeed);
		expect(result.includeContent).toBe(true);
	});
});
