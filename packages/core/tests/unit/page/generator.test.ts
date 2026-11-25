import { describe, expect, it } from "vitest";

import { generatorContent } from "../../../src/page/generator.js";

describe("generatorContent", () => {
	it.each([
		["1.6.2", "EmDash 1"],
		["2.0.0-beta.1", "EmDash 2"],
		["dev", "EmDash"],
	])("turns %s into %s", (version, content) => {
		expect(generatorContent(version)).toBe(content);
	});
});
