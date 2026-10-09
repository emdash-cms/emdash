import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";

describe("CLI arguments", () => {
	it("uses latest by default and accepts another npm dist-tag", () => {
		expect(parseArgs([]).tag).toBe("latest");
		expect(parseArgs(["--to", "next"]).tag).toBe("next");
	});

	it("rejects versions and semver ranges as targets", () => {
		expect(() => parseArgs(["--to", "1.2.0"])).toThrow("npm dist-tag");
		expect(() => parseArgs(["--to", "v1.2.0"])).toThrow("npm dist-tag");
		expect(() => parseArgs(["--to", "^1.2.0"])).toThrow("npm dist-tag");
	});
});
