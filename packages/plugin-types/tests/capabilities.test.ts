import { describe, expect, it } from "vitest";

import {
	CAPABILITY_RENAMES,
	capabilitiesToDeclaredAccess,
	declaredAccessToCapabilities,
	isDeprecatedCapability,
	normalizeCapabilities,
	normalizeCapability,
	pluginManifestSchema,
	reconcileManifestAccess,
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

describe("declaredAccess facet mapping", () => {
	it("validates taxonomy access in plugin manifests", () => {
		expect(
			pluginManifestSchema.safeParse({
				id: "taxonomy-reader",
				version: "1.0.0",
				declaredAccess: { taxonomies: { read: {} } },
				capabilities: ["taxonomies:read"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			}).success,
		).toBe(true);
		const writer = pluginManifestSchema.safeParse({
			id: "taxonomy-writer",
			version: "1.0.0",
			declaredAccess: { taxonomies: { read: {}, write: {} } },
			capabilities: ["taxonomies:read", "taxonomies:write"],
			allowedHosts: [],
			storage: {},
			hooks: [],
			routes: [],
			admin: {},
		});
		expect(writer.success).toBe(true);
		if (!writer.success) return;
		expect(writer.data.declaredAccess?.taxonomies?.write).toEqual({});
		expect(reconcileManifestAccess(writer.data).capabilities).toEqual([
			"taxonomies:read",
			"taxonomies:write",
		]);
	});

	it("validates redirect write access and derives its read implication", () => {
		const parsed = reconcileManifestAccess(
			pluginManifestSchema.parse({
				id: "redirect-manager",
				version: "1.0.0",
				declaredAccess: { redirects: { write: {} } },
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			}),
		);
		expect(new Set(parsed.capabilities)).toEqual(new Set(["redirects:read", "redirects:write"]));
	});

	it("keeps media metadata, bytes, and metadata mutation as independent authority", () => {
		expect(capabilitiesToDeclaredAccess(["media:bytes:read", "media:metadata:write"], [])).toEqual({
			media: { bytesRead: {}, metadataWrite: {} },
		});
		expect(declaredAccessToCapabilities({ media: { bytesRead: {}, metadataWrite: {} } })).toEqual({
			capabilities: ["media:bytes:read", "media:metadata:write"],
			allowedHosts: [],
		});
	});

	it("maps each hook-registration capability to its participation facet", () => {
		expect(capabilitiesToDeclaredAccess(["hooks.content-policy:register"], [])).toEqual({
			content: { policy: {} },
		});
		expect(capabilitiesToDeclaredAccess(["hooks.email-transport:register"], [])).toEqual({
			email: { transport: {} },
		});
		expect(capabilitiesToDeclaredAccess(["hooks.email-events:register"], [])).toEqual({
			email: { events: {} },
		});
		expect(capabilitiesToDeclaredAccess(["hooks.page-fragments:register"], [])).toEqual({
			page: { fragments: {} },
		});
		expect(capabilitiesToDeclaredAccess(["users:read"], [])).toEqual({ users: { read: {} } });
		expect(capabilitiesToDeclaredAccess(["taxonomies:read"], [])).toEqual({
			taxonomies: { read: {} },
		});
		expect(capabilitiesToDeclaredAccess(["taxonomies:write"], [])).toEqual({
			taxonomies: { read: {}, write: {} },
		});
		expect(declaredAccessToCapabilities({ taxonomies: { write: {} } }).capabilities).toEqual([
			"taxonomies:write",
			"taxonomies:read",
		]);
		expect(capabilitiesToDeclaredAccess(["redirects:write"], [])).toEqual({
			redirects: { read: {}, write: {} },
		});
	});

	it("maps schema and revision reads without granting revision history to content read", () => {
		expect(capabilitiesToDeclaredAccess(["schema:read"], [])).toEqual({
			schema: { read: {} },
		});
		expect(capabilitiesToDeclaredAccess(["content:read"], [])).toEqual({
			content: { read: {} },
		});
		expect(capabilitiesToDeclaredAccess(["content:revisions:read"], [])).toEqual({
			content: { read: {}, revisionsRead: {} },
		});
		expect(
			new Set(declaredAccessToCapabilities({ content: { revisionsRead: {} } }).capabilities),
		).toEqual(new Set(["content:read", "content:revisions:read"]));
	});

	it("maps comment moderation to personal-data read consent", () => {
		expect(capabilitiesToDeclaredAccess(["comments:moderate"], [])).toEqual({
			comments: { read: {}, moderate: {} },
		});
		expect(declaredAccessToCapabilities({ comments: { moderate: {} } })).toEqual({
			capabilities: ["comments:moderate", "comments:read"],
			allowedHosts: [],
		});
	});

	it("distinguishes host-restricted from unrestricted network", () => {
		expect(capabilitiesToDeclaredAccess(["network:request"], ["api.example.com"])).toEqual({
			network: { request: { allowedHosts: ["api.example.com"] } },
		});
		// An empty constraint object is the lexicon's spelling of "unrestricted".
		expect(
			capabilitiesToDeclaredAccess(["network:request:unrestricted", "network:request"], []),
		).toEqual({ network: { request: {} } });
	});

	it("never widens an empty allowedHosts (deny-all) to unrestricted", () => {
		// An empty allowedHosts is the most-restrictive spelling (deny-all); it must
		// never decode to unrestricted, or the tightest declaration grants the most.
		expect(capabilitiesToDeclaredAccess(["network:request"], [])).toEqual({
			network: { request: { allowedHosts: [] } },
		});
		const decoded = declaredAccessToCapabilities({ network: { request: { allowedHosts: [] } } });
		expect(decoded.capabilities).not.toContain("network:request:unrestricted");
		expect(decoded).toEqual({ capabilities: ["network:request"], allowedHosts: [] });
	});

	it("carries every facet of an email transport that also calls out and observes events", () => {
		// declaredAccess must carry all three facets so the consent list matches
		// the capability set the runtime enforces.
		const da = capabilitiesToDeclaredAccess(
			["hooks.email-transport:register", "network:request", "hooks.email-events:register"],
			["api.cloudflare.com"],
		);
		expect(da).toEqual({
			network: { request: { allowedHosts: ["api.cloudflare.com"] } },
			email: { transport: {}, events: {} },
		});
		expect(new Set(declaredAccessToCapabilities(da).capabilities)).toEqual(
			new Set(["hooks.email-transport:register", "network:request", "hooks.email-events:register"]),
		);
	});
});

describe("declaredAccess <-> capabilities round-trip (total over the vocabulary)", () => {
	// The full enumeration of implication-closed, valid capability states.
	// definePlugin closes write->read and unrestricted->request, and publish
	// rejects network:request with no hosts, so these are the only states that
	// can reach a published manifest. Every one must round-trip to identity --
	// the guard that the two representations are isomorphic, so the consent list
	// always equals the capability set the runtime enforces.
	const contentChoices = [
		[],
		["content:read"],
		["content:read", "content:write"],
		["content:read", "content:publish"],
		["content:read", "content:revisions:read"],
		["content:read", "content:write", "content:publish"],
		["content:read", "content:write", "content:revisions:read"],
		["content:read", "content:publish", "content:revisions:read"],
		["content:read", "content:write", "content:publish", "content:revisions:read"],
		["content:restore"],
		["content:read", "content:restore"],
		["content:read", "content:write", "content:restore"],
		["content:read", "content:publish", "content:restore"],
		["content:read", "content:revisions:read", "content:restore"],
		["content:read", "content:write", "content:publish", "content:restore"],
		["content:read", "content:write", "content:revisions:read", "content:restore"],
		["content:read", "content:publish", "content:revisions:read", "content:restore"],
		[
			"content:read",
			"content:write",
			"content:publish",
			"content:revisions:read",
			"content:restore",
		],
	];
	const mediaChoices = [
		[],
		["media:read"],
		["media:read", "media:write"],
		["media:bytes:read"],
		["media:read", "media:bytes:read"],
		["media:read", "media:write", "media:bytes:read"],
		["media:metadata:write"],
		["media:read", "media:metadata:write"],
		["media:read", "media:write", "media:metadata:write"],
		["media:bytes:read", "media:metadata:write"],
		["media:read", "media:bytes:read", "media:metadata:write"],
		["media:read", "media:write", "media:bytes:read", "media:metadata:write"],
	];
	const commentChoices = [[], ["comments:read"], ["comments:read", "comments:moderate"]];
	const taxonomyChoices = [[], ["taxonomies:read"], ["taxonomies:read", "taxonomies:write"]];
	const redirectChoices = [[], ["redirects:read"], ["redirects:read", "redirects:write"]];
	const networkChoices: { caps: string[]; hosts: string[] }[] = [
		{ caps: [], hosts: [] },
		{ caps: ["network:request", "network:request:unrestricted"], hosts: [] },
		// Host-restricted with an empty allow-list = deny-all. Must round-trip
		// as restricted, never widening to unrestricted.
		{ caps: ["network:request"], hosts: [] },
		{ caps: ["network:request"], hosts: ["api.example.com"] },
		{ caps: ["network:request"], hosts: ["api.example.com", "*.cdn.example.com"] },
	];
	const singletonFacets = [
		"email:send",
		"hooks.content-policy:register",
		"hooks.email-events:register",
		"hooks.email-transport:register",
		"hooks.page-fragments:register",
		"users:read",
		"schema:read",
	];

	function* states() {
		for (const content of contentChoices) {
			for (const comments of commentChoices) {
				for (const media of mediaChoices) {
					for (const taxonomies of taxonomyChoices) {
						for (const redirects of redirectChoices) {
							for (const network of networkChoices) {
								for (let mask = 0; mask < 1 << singletonFacets.length; mask++) {
									const extra = singletonFacets.filter((_, i) => mask & (1 << i));
									yield {
										capabilities: [
											...content,
											...comments,
											...media,
											...taxonomies,
											...redirects,
											...network.caps,
											...extra,
										],
										allowedHosts: network.hosts,
									};
								}
							}
						}
					}
				}
			}
		}
	}

	it("recovers every implication-closed valid state exactly", () => {
		let count = 0;
		for (const input of states()) {
			const back = declaredAccessToCapabilities(
				capabilitiesToDeclaredAccess(input.capabilities, input.allowedHosts),
			);
			const returnedCapabilities: readonly string[] = back.capabilities;
			if (
				returnedCapabilities.length !== input.capabilities.length ||
				input.capabilities.some((capability) => !returnedCapabilities.includes(capability))
			) {
				throw new Error(`Capability round-trip mismatch: ${JSON.stringify({ input, back })}`);
			}
			if (
				back.allowedHosts.length !== input.allowedHosts.length ||
				input.allowedHosts.some((host) => !back.allowedHosts.includes(host))
			) {
				throw new Error(`Allowed-host round-trip mismatch: ${JSON.stringify({ input, back })}`);
			}
			count++;
		}
		// 18 content x 3 comments x 12 media x 3 taxonomy x 3 redirects x 5 network x 2^7 singleton subsets.
		expect(count).toBe(3_732_480);
	}, 20_000);
});
