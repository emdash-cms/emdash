import { describe, expect, it } from "vitest";

import {
	NODE_NATIVE_EXTERNALS,
	NODE_SSR_EXTERNALS,
} from "../../../src/astro/integration/vite-config.js";

describe("vite-config SSR externals", () => {
	it("extends native externals with the sanitize-html parser stack for Node SSR", () => {
		expect(NODE_SSR_EXTERNALS).toEqual(
			expect.arrayContaining([
				...NODE_NATIVE_EXTERNALS,
				"sanitize-html",
				"htmlparser2",
				"entities",
			]),
		);
	});

	it("does not mutate the native externals list", () => {
		expect(NODE_NATIVE_EXTERNALS).not.toEqual(
			expect.arrayContaining(["sanitize-html", "htmlparser2", "entities"]),
		);
	});
});
