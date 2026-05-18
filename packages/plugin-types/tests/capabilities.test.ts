import { describe, expect, it } from "vitest";

import {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	normalizeCapabilities,
	normalizeCapability,
} from "../src/index.js";

describe("isDeprecatedCapability", () => {
	it("recognises every key of CAPABILITY_RENAMES as deprecated", () => {
		for (const legacy of Object.keys(CAPABILITY_RENAMES)) {
			expect(isDeprecatedCapability(legacy)).toBe(true);
		}
	});

	it("does not flag any rename target as deprecated (renames must be terminal)", () => {
		// If a rename target ended up as another deprecated name, normalization
		// would never settle. Check the closure stops in one step.
		for (const target of Object.values(CAPABILITY_RENAMES)) {
			expect(isDeprecatedCapability(target)).toBe(false);
		}
	});

	it("does not flag prototype property names as deprecated", () => {
		// Object.hasOwn guard: prototype keys must not slip through.
		expect(isDeprecatedCapability("toString")).toBe(false);
		expect(isDeprecatedCapability("constructor")).toBe(false);
		expect(isDeprecatedCapability("__proto__")).toBe(false);
	});
});

describe("normalizeCapability", () => {
	it("rewrites every legacy name to its replacement", () => {
		for (const [legacy, replacement] of Object.entries(CAPABILITY_RENAMES)) {
			expect(normalizeCapability(legacy)).toBe(replacement);
		}
	});

	it("passes current names through unchanged", () => {
		expect(normalizeCapability("network:request")).toBe("network:request");
		expect(normalizeCapability("content:read")).toBe("content:read");
	});

	it("passes unknown strings through unchanged for downstream validators", () => {
		expect(normalizeCapability("not:a:real:cap")).toBe("not:a:real:cap");
	});
});

describe("normalizeCapabilities", () => {
	it("preserves order of first appearance", () => {
		expect(normalizeCapabilities(["content:read", "network:request", "media:read"])).toEqual([
			"content:read",
			"network:request",
			"media:read",
		]);
	});

	it("collapses a legacy name into its canonical equivalent", () => {
		expect(normalizeCapabilities(["read:content"])).toEqual(["content:read"]);
	});

	it("deduplicates when a manifest declares both the legacy and canonical forms", () => {
		// Both `network:fetch` and `network:request` are present -- after
		// normalization both become `network:request`, and the second occurrence
		// is dropped.
		expect(normalizeCapabilities(["network:fetch", "network:request"])).toEqual([
			"network:request",
		]);
		expect(normalizeCapabilities(["network:request", "network:fetch"])).toEqual([
			"network:request",
		]);
	});

	it("handles an empty array", () => {
		expect(normalizeCapabilities([])).toEqual([]);
	});
});
