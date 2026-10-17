import { describe, expect, it } from "vitest";

import {
	buildSerializableConfig,
	emdash,
	resolveImagePlaceholdersDefault,
} from "../../../../src/astro/integration/index.js";

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

describe("imagePlaceholders adapter-aware default", () => {
	it("defaults to true on non-Cloudflare adapters", () => {
		expect(resolveImagePlaceholdersDefault(undefined, false)).toBe(true);
	});

	it("defaults to false on Cloudflare Workers", () => {
		expect(resolveImagePlaceholdersDefault(undefined, true)).toBe(false);
	});

	it("honours explicit true regardless of adapter", () => {
		expect(resolveImagePlaceholdersDefault(true, false)).toBe(true);
		expect(resolveImagePlaceholdersDefault(true, true)).toBe(true);
	});

	it("honours explicit false regardless of adapter", () => {
		expect(resolveImagePlaceholdersDefault(false, false)).toBe(false);
		expect(resolveImagePlaceholdersDefault(false, true)).toBe(false);
	});
});
