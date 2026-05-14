/**
 * Coverage for the manifest -> publish translation layer.
 */

import { describe, expect, it } from "vitest";

import {
	manifestToProfileBootstrap,
	normaliseManifest,
	type NormalisedManifest,
} from "../src/manifest/translate.js";

describe("normaliseManifest", () => {
	it("collapses single-author into authors[]", () => {
		const normalised = normaliseManifest({
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
			license: "MIT",
			authors: [{ name: "A" }, { name: "B" }],
			securityContacts: [{ email: "s@example.com" }],
		});
		expect(normalised.authors).toEqual([{ name: "A" }, { name: "B" }]);
	});

	it("propagates publisher when set", () => {
		const normalised = normaliseManifest({
			license: "MIT",
			publisher: "did:plc:abc",
			author: { name: "Jane" },
			security: { email: "s@example.com" },
		});
		expect(normalised.publisher).toBe("did:plc:abc");
	});
});

describe("manifestToProfileBootstrap", () => {
	it("maps the publish-relevant subset of fields", () => {
		const normalised: NormalisedManifest = {
			license: "MIT",
			publisher: "did:plc:abc",
			authors: [{ name: "Jane", url: "https://example.com" }],
			securityContacts: [{ email: "s@example.com" }],
			name: "Test",
			description: "desc",
			keywords: ["k"],
			repo: "https://github.com/example/p",
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.license).toBe("MIT");
		expect(bootstrap.authorName).toBe("Jane");
		expect(bootstrap.authorUrl).toBe("https://example.com");
		expect(bootstrap.securityEmail).toBe("s@example.com");
	});

	it("uses the first author when multiple are provided", () => {
		const normalised: NormalisedManifest = {
			license: "MIT",
			publisher: undefined,
			authors: [{ name: "First" }, { name: "Second" }],
			securityContacts: [{ email: "s@example.com" }],
			name: undefined,
			description: undefined,
			keywords: undefined,
			repo: undefined,
		};
		const bootstrap = manifestToProfileBootstrap(normalised);
		expect(bootstrap.authorName).toBe("First");
	});
});
