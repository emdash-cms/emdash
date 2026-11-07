import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type * as Emdash from "../../../src/index.js";

/**
 * Reads the built package, so it needs `pnpm build` first. The `sideEffects`
 * list in package.json is applied by the package build: if `src/import/index.ts`
 * drops off it, the build removes the source registrations without an error.
 */
const builtEntry = fileURLToPath(new URL("../../../dist/index.mjs", import.meta.url));

describe("built package", () => {
	it("registers the built-in import sources", async () => {
		const { getAllSources }: typeof Emdash = await import(builtEntry);
		expect(getAllSources().map((source) => source.id)).toEqual(
			expect.arrayContaining(["wordpress-plugin", "wordpress-rest", "wxr"]),
		);
	});
});
