/**
 * Coverage for the manifest -> publish translation layer.
 */

import { describe, expect, it } from "vitest";

import {
	manifestToProfileBootstrap,
	manifestToProfileInput,
	normaliseManifest,
	type NormalisedManifest,
} from "../src/manifest/translate.js";

describe("normaliseManifest", () => {
	it("collapses single-author into authors[]", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.authors).toEqual([{ name: "Jane" }]);
		// Single security contact normalised to array.
		expect(normalised.securityContacts).toEqual([{ email: "s@example.com" }]);
	});

	it("passes the multi-author array through unchanged", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			authors: [{ name: "A" }, { name: "B" }],
			securityContacts: [{ email: "s@example.com" }],
		});
		expect(normalised.authors).toEqual([{ name: "A" }, { name: "B" }]);
	});

	it("propagates publisher when set", () => {
		const normalised = normaliseManifest({
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.publisher).toBe("did:plc:abc");
	});

	it("uses package.json version when manifest omits it", () => {
		const normalised = normaliseManifest(
			{
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			},
			"1.2.3",
		);
		expect(normalised.version).toBe("1.2.3");
	});

	it("uses manifest version when no package.json version is provided", () => {
		const normalised = normaliseManifest({
			version: "0.9.0",
			license: "MIT",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.version).toBe("0.9.0");
	});

	it("accepts matching versions from both sources", () => {
		const normalised = normaliseManifest(
			{
				version: "2.0.0",
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			},
			"2.0.0",
		);
		expect(normalised.version).toBe("2.0.0");
	});

	it("throws on mismatched versions", () => {
		expect(() =>
			normaliseManifest(
				{
					version: "1.0.0",
					license: "MIT",
					author: { name: "Jane" },
					security: { email: "s@example.com" },
				},
				"2.0.0",
			),
		).toThrow(/disagrees/);
	});

	it("throws when no version is available anywhere", () => {
		expect(() =>
			normaliseManifest({
				license: "MIT",
				author: { name: "Jane" },
				security: { email: "s@example.com" },
			}),
		).toThrow(/not set/);
	});
});

describe("manifestToProfileBootstrap", () => {
	it("maps the publish-relevant subset of fields", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Jane", url: "https://example.com" }],
			securityContacts: [{ email: "s@example.com" }],
			name: "Test",
			description: "desc",
			keywords: ["k"],
			repo: "https://github.com/example/p",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.license).toBe("MIT");
		expect(bootstrap.authorName).toBe("Jane");
		expect(bootstrap.authorUrl).toBe("https://example.com");
		expect(bootstrap.securityEmail).toBe("s@example.com");
	});

	it("uses the first author when multiple are provided", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "First" }, { name: "Second" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.authorName).toBe("First");
	});
});

describe("manifestToProfileInput", () => {
	it("carries the full lexicon profile block (multi-author, multi-security)", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "Apache-2.0",
			publisher: "did:plc:abc",
			authors: [
				{ name: "Jane", url: "https://example.com" },
				{ name: "Bob", email: "bob@example.com" },
			],
			securityContacts: [{ email: "s@example.com" }, { url: "https://example.com/sec" }],
			name: "Test",
			description: "desc",
			keywords: ["k1", "k2"],
			repo: "https://github.com/example/p",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const input = manifestToProfileInput(normalised);
		expect(input.license).toBe("Apache-2.0");
		expect(input.authors).toEqual([
			{ name: "Jane", url: "https://example.com" },
			{ name: "Bob", email: "bob@example.com" },
		]);
		expect(input.security).toEqual([
			{ email: "s@example.com" },
			{ url: "https://example.com/sec" },
		]);
		expect(input.name).toBe("Test");
		expect(input.description).toBe("desc");
		expect(input.keywords).toEqual(["k1", "k2"]);
	});

	it("omits name, description and keywords when the manifest doesn't set them", () => {
		const normalised: NormalisedManifest = {
			slug: "test",
			version: "0.1.0",
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Solo" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
			capabilities: [],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
		};
		const input = manifestToProfileInput(normalised);
		expect("name" in input).toBe(false);
		expect("description" in input).toBe(false);
		expect("keywords" in input).toBe(false);
	});
});
