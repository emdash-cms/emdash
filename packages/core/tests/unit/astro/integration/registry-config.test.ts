import { describe, expect, it } from "vitest";

import emdash from "../../../../src/astro/integration/index.js";
import {
	DEFAULT_REGISTRY_AGGREGATOR_URL,
	resolveRegistryConfigForSandbox,
} from "../../../../src/registry/config.js";

describe("registry integration configuration", () => {
	it("uses the hosted registry by default when the plugin sandbox is enabled", () => {
		expect(
			resolveRegistryConfigForSandbox({ sandboxRunner: "./sandbox.mjs", sandboxEnabled: true }),
		).toEqual({ input: DEFAULT_REGISTRY_AGGREGATOR_URL, fieldPrefix: "registry" });
		expect(
			resolveRegistryConfigForSandbox({ sandboxRunner: "./sandbox.mjs", sandboxEnabled: false }),
		).toEqual({ fieldPrefix: "registry" });
	});

	it("gives the top-level registry option precedence over the legacy option", () => {
		const registry = { aggregatorUrl: "https://registry.example.com" };

		expect(
			resolveRegistryConfigForSandbox({
				registry,
				experimentalRegistry: { aggregatorUrl: "not a URL" },
				sandboxRunner: "./sandbox.mjs",
				sandboxEnabled: true,
			}),
		).toEqual({ input: registry, fieldPrefix: "registry" });
	});

	it("allows the top-level option to disable registry discovery", () => {
		expect(
			resolveRegistryConfigForSandbox({
				registry: false,
				experimentalRegistry: { aggregatorUrl: "not a URL" },
				sandboxRunner: "./sandbox.mjs",
				sandboxEnabled: true,
			}),
		).toEqual({ fieldPrefix: "registry" });

		expect(() =>
			emdash({
				registry: false,
				experimental: { registry: { aggregatorUrl: "not a URL" } },
				sandboxRunner: "./sandbox.mjs",
			}),
		).not.toThrow();
	});

	it.each([
		["a malformed aggregator URL", { aggregatorUrl: "not a URL" }, "aggregatorUrl"],
		[
			"an insecure non-local aggregator",
			{ aggregatorUrl: "http://registry.example.com" },
			"aggregatorUrl",
		],
		[
			"an invalid minimum release age",
			{
				aggregatorUrl: "https://registry.example.com",
				policy: { minimumReleaseAge: "tomorrow" },
			},
			"policy.minimumReleaseAge",
		],
	] as const)("fails during integration creation for %s", (_label, registry, field) => {
		expect(() => emdash({ registry })).toThrow(
			new RegExp(`EmDash registry configuration error in registry[.]${field}`),
		);
	});

	it("accepts shorthand and full registry configuration", () => {
		expect(() => emdash({ registry: "https://registry.example.com" })).not.toThrow();
		expect(() =>
			emdash({
				registry: {
					aggregatorUrl: "https://registry.example.com/",
					acceptLabelers: "did:web:labeler.example",
					policy: { minimumReleaseAge: "48h" },
				},
			}),
		).not.toThrow();
		expect(() =>
			emdash({ experimental: { registry: "https://legacy-registry.example.com" } }),
		).not.toThrow();
	});
});
