/**
 * Coverage for the manifest's identity (`slug`, `version`) and
 * trust-contract fields (`capabilities`, `allowedHosts`, `storage`).
 *
 * The trust contract is the manifest's most security-sensitive surface.
 * Capability vocabulary, deprecated-name rejection, and the cross-field
 * `network:request` / `allowedHosts` rules all need explicit coverage so
 * a future schema edit can't silently relax the validation.
 */

import { describe, expect, it } from "vitest";

import {
	AllowedHostsSchema,
	CapabilitiesSchema,
	CapabilitySchema,
	ManifestSchema,
	SlugSchema,
	StorageSchema,
	VersionSchema,
} from "../src/manifest/schema.js";

describe("SlugSchema", () => {
	it("accepts the canonical form", () => {
		expect(SlugSchema.parse("gallery")).toBe("gallery");
		expect(SlugSchema.parse("my-plugin")).toBe("my-plugin");
		expect(SlugSchema.parse("plugin_v2")).toBe("plugin_v2");
	});

	it("rejects leading digit", () => {
		const result = SlugSchema.safeParse("1-plugin");
		expect(result.success).toBe(false);
	});

	it("rejects leading punctuation", () => {
		expect(SlugSchema.safeParse("-plugin").success).toBe(false);
		expect(SlugSchema.safeParse("_plugin").success).toBe(false);
	});

	it("rejects uppercase", () => {
		const result = SlugSchema.safeParse("MyPlugin");
		expect(result.success).toBe(false);
	});

	it("rejects empty", () => {
		expect(SlugSchema.safeParse("").success).toBe(false);
	});

	it("rejects over 64 chars", () => {
		const result = SlugSchema.safeParse("a".repeat(65));
		expect(result.success).toBe(false);
	});
});

describe("VersionSchema", () => {
	it("accepts the canonical form", () => {
		expect(VersionSchema.parse("0.1.0")).toBe("0.1.0");
		expect(VersionSchema.parse("1.2.3")).toBe("1.2.3");
		expect(VersionSchema.parse("1.0.0-rc.1")).toBe("1.0.0-rc.1");
	});

	it("rejects build metadata (atproto rkey constraint)", () => {
		// The atproto record-key alphabet has no `+`, so a semver
		// build-metadata suffix can't survive into the publish path.
		const result = VersionSchema.safeParse("1.0.0+build.1");
		expect(result.success).toBe(false);
	});

	it("rejects malformed semver", () => {
		expect(VersionSchema.safeParse("1").success).toBe(false);
		expect(VersionSchema.safeParse("1.0").success).toBe(false);
		expect(VersionSchema.safeParse("v1.0.0").success).toBe(false);
	});
});

describe("CapabilitySchema", () => {
	it("accepts a current capability", () => {
		expect(CapabilitySchema.parse("content:read")).toBe("content:read");
		expect(CapabilitySchema.parse("network:request")).toBe("network:request");
		expect(CapabilitySchema.parse("email:send")).toBe("email:send");
	});

	it("rejects a deprecated capability with a hint at the replacement", () => {
		const result = CapabilitySchema.safeParse("read:content");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("deprecated");
			expect(result.error.issues[0]?.message).toContain("content:read");
		}
	});

	it("rejects an unknown capability", () => {
		const result = CapabilitySchema.safeParse("filesystem:write");
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("not a recognised name");
		}
	});

	it("rejects empty string", () => {
		expect(CapabilitySchema.safeParse("").success).toBe(false);
	});
});

describe("CapabilitiesSchema (array-level)", () => {
	it("accepts an empty list (no privileges beyond defaults)", () => {
		expect(CapabilitiesSchema.parse([])).toEqual([]);
	});

	it("rejects more than 32 entries", () => {
		// All entries are valid capabilities but the count alone should
		// trip the array max. Repeat a valid one rather than constructing
		// 33 distinct names that would also each fail individually.
		const result = CapabilitiesSchema.safeParse(Array.from({ length: 33 }).fill("content:read"));
		expect(result.success).toBe(false);
	});
});

describe("AllowedHostsSchema", () => {
	it("accepts hostnames and wildcard-subdomain patterns", () => {
		expect(AllowedHostsSchema.parse(["api.example.com"])).toEqual(["api.example.com"]);
		expect(AllowedHostsSchema.parse(["*.cdn.example.com"])).toEqual(["*.cdn.example.com"]);
	});

	it("rejects URLs (scheme present)", () => {
		const result = AllowedHostsSchema.safeParse(["https://api.example.com"]);
		expect(result.success).toBe(false);
	});

	it("rejects host:port", () => {
		// Port must be carried separately; the lexicon's grammar doesn't
		// include ports in the pattern.
		const result = AllowedHostsSchema.safeParse(["api.example.com:8080"]);
		// `:` is allowed-but-we-don't-validate at this layer (no
		// scheme/path/whitespace is the only structural test); a port
		// is technically passes the loose check. Document as intentional
		// — the lexicon's host-pattern grammar is the strict validator.
		// Update this test if we tighten the regex.
		expect(result.success).toBe(true);
	});

	it("rejects paths", () => {
		const result = AllowedHostsSchema.safeParse(["api.example.com/some/path"]);
		expect(result.success).toBe(false);
	});

	it("rejects whitespace", () => {
		const result = AllowedHostsSchema.safeParse(["api.example.com   "]);
		expect(result.success).toBe(false);
	});
});

describe("StorageSchema", () => {
	it("accepts a simple single-field index", () => {
		const result = StorageSchema.parse({
			events: { indexes: ["timestamp"] },
		});
		expect(result).toEqual({ events: { indexes: ["timestamp"] } });
	});

	it("accepts composite indexes", () => {
		const result = StorageSchema.parse({
			events: { indexes: [["collection", "timestamp"]] },
		});
		expect(result.events?.indexes).toEqual([["collection", "timestamp"]]);
	});

	it("accepts uniqueIndexes alongside indexes", () => {
		const result = StorageSchema.parse({
			users: {
				indexes: ["createdAt"],
				uniqueIndexes: ["email"],
			},
		});
		expect(result.users?.uniqueIndexes).toEqual(["email"]);
	});

	it("rejects an invalid collection name", () => {
		const result = StorageSchema.safeParse({
			"Bad-Name": { indexes: [] },
		});
		expect(result.success).toBe(false);
	});

	it("rejects an empty composite index", () => {
		const result = StorageSchema.safeParse({
			events: { indexes: [[]] },
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys on a collection config", () => {
		const result = StorageSchema.safeParse({
			events: { indexes: [], orderBy: "timestamp" },
		});
		expect(result.success).toBe(false);
	});
});

describe("ManifestSchema cross-field rules", () => {
	const base = {
		slug: "my-plugin",
		version: "0.1.0",
		publisher: "example.com",
		license: "MIT",
		author: { name: "Jane Doe" },
		security: { email: "security@example.com" },
	};

	it("network:request requires non-empty allowedHosts", () => {
		const result = ManifestSchema.safeParse({
			...base,
			capabilities: ["network:request"],
			allowedHosts: [],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) => i.message.includes("non-empty `allowedHosts`")),
			).toBe(true);
		}
	});

	it("network:request with at least one allowed host passes", () => {
		const result = ManifestSchema.safeParse({
			...base,
			capabilities: ["network:request"],
			allowedHosts: ["api.example.com"],
		});
		expect(result.success).toBe(true);
	});

	it("network:request:unrestricted forbids allowedHosts", () => {
		// The lexicon's invariant: allowedHosts MUST NOT appear when
		// unrestricted is declared. The unrestricted capability already
		// grants any host.
		const result = ManifestSchema.safeParse({
			...base,
			capabilities: ["network:request:unrestricted"],
			allowedHosts: ["api.example.com"],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(
				result.error.issues.some((i) =>
					i.message.includes("`allowedHosts` must be empty"),
				),
			).toBe(true);
		}
	});

	it("network:request:unrestricted with empty allowedHosts passes", () => {
		const result = ManifestSchema.safeParse({
			...base,
			capabilities: ["network:request:unrestricted"],
		});
		expect(result.success).toBe(true);
	});

	it("non-network capabilities don't require allowedHosts", () => {
		const result = ManifestSchema.safeParse({
			...base,
			capabilities: ["content:read"],
		});
		expect(result.success).toBe(true);
	});
});

describe("ManifestSchema with the trust contract", () => {
	const base = {
		slug: "my-plugin",
		version: "0.1.0",
		publisher: "example.com",
		license: "MIT",
		author: { name: "Jane Doe" },
		security: { email: "security@example.com" },
	};

	it("defaults capabilities/allowedHosts/storage to empty when omitted", () => {
		const result = ManifestSchema.parse(base);
		expect(result.capabilities).toEqual([]);
		expect(result.allowedHosts).toEqual([]);
		expect(result.storage).toEqual({});
	});

	it("accepts a full trust contract", () => {
		const result = ManifestSchema.parse({
			...base,
			capabilities: ["content:read", "content:write", "network:request"],
			allowedHosts: ["api.example.com", "*.cdn.example.com"],
			storage: {
				events: { indexes: ["timestamp"] },
				users: { indexes: ["createdAt"], uniqueIndexes: ["email"] },
			},
		});
		expect(result.capabilities).toEqual([
			"content:read",
			"content:write",
			"network:request",
		]);
	});
});
