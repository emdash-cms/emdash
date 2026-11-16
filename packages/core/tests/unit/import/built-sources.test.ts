import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type * as Emdash from "../../../src/index.js";

/**
 * Reads the built package, so it is skipped until `pnpm build` has run. It
 * checks what a site gets: a bundler drops modules whose exports nobody uses,
 * so this catches the built-in import sources going missing from `dist`.
 */
const builtEntry = fileURLToPath(new URL("../../../dist/index.mjs", import.meta.url));

describe("built package", () => {
	it.skipIf(!existsSync(builtEntry))("registers the built-in import sources", async () => {
		const { getAllSources }: typeof Emdash = await import(builtEntry);
		expect(getAllSources().map((source) => source.id)).toEqual(
			expect.arrayContaining(["wordpress-plugin", "wordpress-rest", "wxr"]),
		);
	});
});
