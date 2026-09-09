import { describe, expect, it } from "vitest";

import { extractManifest as extractCliManifest } from "../../../../plugin-cli/src/bundle/utils.js";
import { pluginManifestSchema as sharedManifestSchema } from "../../../../plugin-types/src/manifest-schema.js";
import { extractManifest as extractCoreManifest } from "../../../src/cli/commands/bundle-utils.js";
import { pluginManifestSchema as coreManifestSchema } from "../../../src/plugins/manifest-schema.js";

const options = {
	public: true,
	permission: "content:create" as const,
	cacheControl: "public, max-age=60",
};

describe.each([
	{ name: "core", extract: extractCoreManifest },
	{ name: "standalone CLI", extract: extractCliManifest },
])("$name route manifest round trip", ({ extract }) => {
	it.each([
		{ name: "core", schema: coreManifestSchema },
		{ name: "shared", schema: sharedManifestSchema },
	])("preserves route options through the $name reader", ({ schema }) => {
		const manifest = extract({
			id: "route-contract",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			hooks: {},
			routes: {
				catalog: { ...options, handler: async () => ({ items: [] }) },
				private: { public: false, handler: async () => null },
				legacy: { handler: async () => null },
			},
			admin: {},
		});
		const parsed = schema.parse(JSON.parse(JSON.stringify(manifest)));
		expect(parsed.routes).toEqual([
			{ name: "catalog", ...options },
			{ name: "private", public: false },
			"legacy",
		]);
	});
});
