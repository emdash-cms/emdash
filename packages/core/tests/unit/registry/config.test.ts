import { describe, expect, it } from "vitest";

import {
	normalizeRegistryConfig,
	resolveManifestRegistryConfig,
} from "../../../src/registry/config.js";

describe("normalizeRegistryConfig", () => {
	it("rejects mutable handles in the minimum release age exemption list", () => {
		expect(() =>
			normalizeRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: { minimumReleaseAgeExclude: ["publisher.example.com"] },
			}),
		).toThrow(/minimumReleaseAgeExclude entry must be a DID or <did>\/<slug>/);
	});

	it("normalizes DID and package exemptions", () => {
		expect(
			normalizeRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: {
					minimumReleaseAgeExclude: ["DID:PLC:EXAMPLE", "DID:WEB:PUBLISHER.EXAMPLE/Gallery"],
				},
			}),
		).toMatchObject({
			policy: {
				minimumReleaseAgeExclude: ["did:plc:example", "did:web:publisher.example/gallery"],
			},
		});
	});

	it.each([
		["a malformed URL", "not a URL", "REGISTRY_AGGREGATOR_URL_INVALID"],
		["a forbidden target", "http://registry.example.com", "REGISTRY_AGGREGATOR_URL_FORBIDDEN"],
	] as const)("returns a safe manifest diagnostic for %s", (_label, aggregatorUrl, code) => {
		expect(resolveManifestRegistryConfig({ aggregatorUrl })).toEqual({
			error: {
				code,
				field: "experimental.registry.aggregatorUrl",
			},
		});
	});

	it("returns a safe manifest diagnostic for an invalid minimum release age", () => {
		expect(
			resolveManifestRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: { minimumReleaseAge: "tomorrow" },
			}),
		).toEqual({
			error: {
				code: "REGISTRY_MINIMUM_RELEASE_AGE_INVALID",
				field: "experimental.registry.policy.minimumReleaseAge",
			},
		});
	});

	it("returns a safe manifest diagnostic when release age exclusions are not an array", () => {
		expect(
			resolveManifestRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: {
					// @ts-expect-error - runtime validation covers untyped JavaScript configuration
					minimumReleaseAgeExclude: "did:plc:publisher",
				},
			}),
		).toEqual({
			error: {
				code: "REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID",
				field: "experimental.registry.policy.minimumReleaseAgeExclude",
			},
		});
	});

	it("does not turn unexpected failures into configuration diagnostics", () => {
		const input = {
			aggregatorUrl: "https://registry.example.com",
			policy: {
				get minimumReleaseAge(): string {
					throw new Error("unexpected getter failure");
				},
			},
		};

		expect(() => resolveManifestRegistryConfig(input)).toThrow("unexpected getter failure");
	});
});
