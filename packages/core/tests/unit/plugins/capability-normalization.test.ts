/**
 * Capability Normalization Tests
 *
 * Tests the deprecation alias layer for plugin capability names. The runtime
 * never sees deprecated names — `normalizeCapability()` rewrites them at
 * every external boundary (definePlugin, adaptSandboxEntry, marketplace
 * diff). These tests pin the rename map and the normalization helpers so
 * that the alias layer keeps working until the deprecated names are
 * removed in the next minor.
 *
 * @see Issue: "Plugin capability names are inconsistent"
 */

import { describe, it, expect } from "vitest";

import {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	normalizeCapabilities,
	normalizeCapability,
} from "../../../src/plugins/types.js";
import type { DeprecatedPluginCapability } from "../../../src/plugins/types.js";

describe("CAPABILITY_RENAMES", () => {
	it("maps every deprecated name to its current replacement", () => {
		// Pin the rename table — if the issue's table changes, this test
		// catches the drift. Anyone adding a deprecation should update
		// this case explicitly.
		expect(CAPABILITY_RENAMES).toEqual({
			"network:fetch": "network:request",
			"network:fetch:any": "network:request:unrestricted",
			"read:content": "content:read",
			"write:content": "content:write",
			"read:media": "media:read",
			"write:media": "media:write",
			"read:users": "users:read",
			"email:provide": "hooks.email-transport:register",
			"email:intercept": "hooks.email-events:register",
			"page:inject": "hooks.page-fragments:register",
		});
	});

	it("is frozen — cannot be mutated at runtime", () => {
		// `Object.freeze` makes the rename table tamper-proof.
		expect(Object.isFrozen(CAPABILITY_RENAMES)).toBe(true);
	});
});

describe("isDeprecatedCapability", () => {
	it("returns true for every deprecated name in the rename table", () => {
		for (const cap of Object.keys(CAPABILITY_RENAMES) as DeprecatedPluginCapability[]) {
			expect(isDeprecatedCapability(cap)).toBe(true);
		}
	});

	it("returns false for current capability names", () => {
		const current = [
			"content:read",
			"content:write",
			"media:read",
			"media:write",
			"users:read",
			"network:request",
			"network:request:unrestricted",
			"email:send",
			"hooks.email-transport:register",
			"hooks.email-events:register",
			"hooks.page-fragments:register",
		];
		for (const cap of current) {
			expect(isDeprecatedCapability(cap)).toBe(false);
		}
	});

	it("returns false for unknown strings", () => {
		expect(isDeprecatedCapability("not:a:capability")).toBe(false);
		expect(isDeprecatedCapability("")).toBe(false);
		expect(isDeprecatedCapability("content")).toBe(false);
	});
});

describe("normalizeCapability", () => {
	it("rewrites deprecated names to current names", () => {
		expect(normalizeCapability("read:content")).toBe("content:read");
		expect(normalizeCapability("write:content")).toBe("content:write");
		expect(normalizeCapability("read:media")).toBe("media:read");
		expect(normalizeCapability("write:media")).toBe("media:write");
		expect(normalizeCapability("read:users")).toBe("users:read");
		expect(normalizeCapability("network:fetch")).toBe("network:request");
		expect(normalizeCapability("network:fetch:any")).toBe("network:request:unrestricted");
		expect(normalizeCapability("email:provide")).toBe("hooks.email-transport:register");
		expect(normalizeCapability("email:intercept")).toBe("hooks.email-events:register");
		expect(normalizeCapability("page:inject")).toBe("hooks.page-fragments:register");
	});

	it("leaves current names unchanged", () => {
		expect(normalizeCapability("content:read")).toBe("content:read");
		expect(normalizeCapability("network:request")).toBe("network:request");
		expect(normalizeCapability("hooks.email-transport:register")).toBe(
			"hooks.email-transport:register",
		);
	});

	it("passes through unknown strings unchanged", () => {
		// Downstream validators throw on unknown capabilities; the
		// normalizer's job is purely to translate the alias map.
		expect(normalizeCapability("invalid:capability")).toBe("invalid:capability");
		expect(normalizeCapability("")).toBe("");
	});
});

describe("normalizeCapabilities", () => {
	it("rewrites every deprecated name in an array", () => {
		const input = ["read:content", "write:content", "network:fetch"];
		const result = normalizeCapabilities(input);

		expect(result).toEqual(["content:read", "content:write", "network:request"]);
	});

	it("preserves order of first occurrence", () => {
		const result = normalizeCapabilities(["network:request", "read:content", "write:media"]);

		expect(result).toEqual(["network:request", "content:read", "media:write"]);
	});

	it("deduplicates by canonical name when both old and new are present", () => {
		// A plugin migrating from old to new might transiently declare
		// both — the normalizer must not produce duplicates.
		const result = normalizeCapabilities(["read:content", "content:read"]);

		expect(result).toEqual(["content:read"]);
	});

	it("deduplicates two deprecated names that map to the same current name", () => {
		// Defensive: if someone declares the same alias twice, the result
		// must still contain it only once.
		const result = normalizeCapabilities(["read:content", "read:content"]);

		expect(result).toEqual(["content:read"]);
	});

	it("returns empty array for empty input", () => {
		expect(normalizeCapabilities([])).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const input = ["read:content", "write:content"];
		const snapshot = [...input];
		normalizeCapabilities(input);

		expect(input).toEqual(snapshot);
	});

	it("is idempotent — normalizing twice gives the same result", () => {
		const input = ["read:content", "write:media", "page:inject"];
		const once = normalizeCapabilities(input);
		const twice = normalizeCapabilities(once);

		expect(twice).toEqual(once);
	});
});
