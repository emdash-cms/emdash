import { describe, expect, it } from "vitest";

import { buildSerializableConfig, emdash } from "../../../../src/astro/integration/index.js";

describe("buildSerializableConfig", () => {
	it("passes the update-check opt-out to the runtime config", () => {
		expect(buildSerializableConfig({ updateCheck: false }).updateCheck).toBe(false);
	});
});

describe("updateCheck option", () => {
	it("rejects an invalid minimum release age during integration setup", () => {
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "soon" } })).toThrow(
			/updateCheck\.minimumReleaseAge.*soon/,
		);
		expect(() => emdash({ updateCheck: { minimumReleaseAge: "48h" } })).not.toThrow();
	});
});
