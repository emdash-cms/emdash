import { is, safeParse } from "@atcute/lexicons/validations";
import { describe, expect, it } from "vitest";

import { NSID, PackageProfile, PackageRelease, PublisherProfile } from "../src/index.js";

/**
 * Smoke tests over the generated types and validation schemas. The goal isn't
 * exhaustive coverage of the lexicons (the JSON files are the spec; codegen is
 * deterministic) -- it's to catch:
 *
 *   1. Codegen drift: if a regen produces something importable but broken.
 *   2. Schema-vs-type drift: types and runtime schemas come from the same
 *      generation, so they should always agree.
 *   3. NSID typos in our hand-maintained `NSID` map.
 *
 * Each test builds a representative record, validates it via the runtime
 * schema, and uses the inferred type for the variable so a TS error surfaces
 * if the shape ever changes incompatibly.
 */

describe("PackageProfile", () => {
	it("validates a minimal valid profile", () => {
		const profile: PackageProfile.Main = {
			$type: NSID.packageProfile,
			id: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/gallery",
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Alice Example", url: "https://alice.example.com" }],
			security: [{ email: "security@example.com" }],
		};

		const result = safeParse(PackageProfile.mainSchema, profile);
		expect(result.ok).toBe(true);
	});

	it("rejects a profile missing required authors", () => {
		const bad = {
			$type: NSID.packageProfile,
			id: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/gallery",
			type: "emdash-plugin",
			license: "MIT",
			// authors omitted
			security: [{ email: "security@example.com" }],
		};

		expect(is(PackageProfile.mainSchema, bad)).toBe(false);
	});

	it("rejects a profile with empty authors array", () => {
		const bad = {
			$type: NSID.packageProfile,
			id: "at://did:plc:abc123/com.emdashcms.experimental.package.profile/gallery",
			type: "emdash-plugin",
			license: "MIT",
			authors: [],
			security: [{ email: "security@example.com" }],
		};

		expect(is(PackageProfile.mainSchema, bad)).toBe(false);
	});

	it("rejects a profile with a non-AT-URI id", () => {
		const bad = {
			$type: NSID.packageProfile,
			id: "https://example.com/not-an-at-uri",
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "Alice" }],
			security: [{ email: "security@example.com" }],
		};

		expect(is(PackageProfile.mainSchema, bad)).toBe(false);
	});

	it("accepts known package types and arbitrary x- types", () => {
		const known: PackageProfile.Main = {
			$type: NSID.packageProfile,
			id: "at://did:plc:abc/com.emdashcms.experimental.package.profile/p1",
			type: "emdash-plugin",
			license: "MIT",
			authors: [{ name: "A" }],
			security: [{ email: "security@example.com" }],
		};

		const custom: PackageProfile.Main = {
			...known,
			type: "x-custom-host",
		};

		expect(is(PackageProfile.mainSchema, known)).toBe(true);
		expect(is(PackageProfile.mainSchema, custom)).toBe(true);
	});
});

describe("PackageRelease", () => {
	it("validates a minimal valid release", () => {
		const release: PackageRelease.Main = {
			$type: NSID.packageRelease,
			package: "gallery",
			version: "1.0.0",
			artifacts: {
				package: {
					url: "https://github.com/example/gallery/releases/download/v1.0.0/gallery.tar.gz",
					checksum: "bciqkkpvkbtfcwq6kjkbq3kgjxe5j6ihzkxlfxkzqhwzaaaa3wkbq3a",
				},
			},
		};

		const result = safeParse(PackageRelease.mainSchema, release);
		expect(result.ok).toBe(true);
	});

	it("rejects a release without a package artifact", () => {
		const bad = {
			$type: NSID.packageRelease,
			package: "gallery",
			version: "1.0.0",
			artifacts: {
				icon: {
					url: "https://example.com/icon.png",
					checksum: "bcixyz",
				},
				// no `package` artifact
			},
		};

		expect(is(PackageRelease.mainSchema, bad)).toBe(false);
	});
});

describe("PublisherProfile", () => {
	it("validates a publisher profile with only required fields", () => {
		// Only `displayName` is required by the lexicon. Verification records bind
		// against this value, so it's the one field a publisher must commit to.
		const profile: PublisherProfile.Main = {
			$type: NSID.publisherProfile,
			displayName: "Acme Plugin Co.",
		};

		expect(is(PublisherProfile.mainSchema, profile)).toBe(true);
	});

	it("rejects a publisher profile missing displayName", () => {
		const bad = {
			$type: NSID.publisherProfile,
			description: "Plugins for the cool kids",
		};

		expect(is(PublisherProfile.mainSchema, bad)).toBe(false);
	});
});

describe("NSID map", () => {
	it("has every NSID we generated a module for", () => {
		// If you add a lexicon, regen, and forget to update the NSID map, this
		// test reminds you. It's a coarse check by count, but the values are
		// also sanity-checked in the schema modules' `$type` literals above.
		const expected = [
			"com.emdashcms.experimental.package.profile",
			"com.emdashcms.experimental.package.release",
			"com.emdashcms.experimental.package.releaseExtension",
			"com.emdashcms.experimental.publisher.profile",
			"com.emdashcms.experimental.publisher.verification",
			"com.emdashcms.experimental.aggregator.defs",
			"com.emdashcms.experimental.aggregator.getLatestRelease",
			"com.emdashcms.experimental.aggregator.getPackage",
			"com.emdashcms.experimental.aggregator.listReleases",
			"com.emdashcms.experimental.aggregator.resolvePackage",
			"com.emdashcms.experimental.aggregator.searchPackages",
		].toSorted();

		const actual = Object.values(NSID).toSorted();
		expect(actual).toEqual(expected);
	});
});
