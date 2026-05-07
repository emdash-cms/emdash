import type { PluginManifest } from "@emdash-cms/plugin-types";
import { PublishingClient } from "@emdash-cms/registry-client";
import type { Did } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	PublishError,
	publishRelease,
	type ProfileBootstrap,
	type PublishOptions,
} from "../src/publish/api.js";
import { MockPds } from "./mock-pds.js";

const TEST_DID: Did = "did:plc:test123";

function buildManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
		...overrides,
	};
}

function buildPublisher(pds: MockPds): PublishingClient {
	return PublishingClient.fromHandler({
		handler: pds,
		did: pds.did,
		pds: "http://mock.test",
	});
}

const validProfile: ProfileBootstrap = {
	license: "MIT",
	authorName: "Alice",
	securityEmail: "security@example.com",
};

function buildOptions(pds: MockPds, overrides: Partial<PublishOptions> = {}): PublishOptions {
	return {
		publisher: buildPublisher(pds),
		did: pds.did,
		manifest: buildManifest(),
		checksum: "bciqtestchecksum",
		url: "https://example.com/test-plugin-1.0.0.tar.gz",
		profile: validProfile,
		...overrides,
	};
}

describe("publishRelease", () => {
	describe("first publish for a new slug", () => {
		it("creates the profile record and the release record", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const result = await publishRelease(buildOptions(pds));

			expect(result.profileCreated).toBe(true);
			expect(result.releaseOverwritten).toBe(false);
			expect(result.slug).toBe("test-plugin");
			expect(result.profileUri).toBe(`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`);
			expect(result.releaseUri).toBe(`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.0.0`);

			// Both records should be in the mock PDS.
			expect(pds.records.size).toBe(2);
			expect(pds.records.has(result.profileUri)).toBe(true);
			expect(pds.records.has(result.releaseUri)).toBe(true);
		});

		it("commits both records in a single applyWrites batch (atomic)", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await publishRelease(buildOptions(pds));

			// Atomicity contract: ONE applyWrites call, with both records as
			// writes. Two separate putRecord calls would mean an interrupted
			// publish could leave a profile without a release.
			const applyWrites = pds.callsTo("com.atproto.repo.applyWrites");
			expect(applyWrites).toHaveLength(1);
			const body = applyWrites[0]!.body as { writes: unknown[] };
			expect(body.writes).toHaveLength(2);

			// putRecord must NOT be used for the publish path.
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("populates the profile record from ProfileBootstrap fields", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await publishRelease(
				buildOptions(pds, {
					profile: {
						license: "Apache-2.0",
						authorName: "Acme",
						authorUrl: "https://acme.example.com",
						authorEmail: "hi@acme.example.com",
						securityEmail: "security@acme.example.com",
					},
				}),
			);

			const profile = pds.records.get(`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`);
			expect(profile).toBeDefined();
			const value = profile!.value as {
				license: string;
				authors: Array<{ name: string; url?: string; email?: string }>;
				security: Array<{ email?: string; url?: string }>;
				slug: string;
				type: string;
			};
			expect(value.license).toBe("Apache-2.0");
			expect(value.authors[0]).toMatchObject({
				name: "Acme",
				url: "https://acme.example.com",
				email: "hi@acme.example.com",
			});
			expect(value.security[0]).toMatchObject({
				email: "security@acme.example.com",
			});
			expect(value.slug).toBe("test-plugin");
			expect(value.type).toBe("emdash-plugin");
		});

		it("populates the release record with the artifact URL and checksum", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await publishRelease(buildOptions(pds));

			const release = pds.records.get(`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.0.0`);
			expect(release).toBeDefined();
			const value = release!.value as {
				package: string;
				version: string;
				artifacts: { package: { url: string; checksum: string; contentType?: string } };
			};
			expect(value.package).toBe("test-plugin");
			expect(value.version).toBe("1.0.0");
			expect(value.artifacts.package.url).toBe("https://example.com/test-plugin-1.0.0.tar.gz");
			expect(value.artifacts.package.checksum).toBe("bciqtestchecksum");
			expect(value.artifacts.package.contentType).toBe("application/gzip");
		});

		it("hard-fails when license is missing, with no records written", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				profile: { securityEmail: "security@example.com" },
			});
			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "PROFILE_BOOTSTRAP_MISSING_FIELD",
			});
			expect(pds.records.size).toBe(0);
			// applyWrites must not have been called -- a partial write would be
			// catastrophic for an atomic-publish promise.
			expect(pds.callsTo("com.atproto.repo.applyWrites")).toHaveLength(0);
		});

		it("hard-fails when both securityEmail and securityUrl are missing", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, { profile: { license: "MIT" } });
			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "PROFILE_BOOTSTRAP_MISSING_FIELD",
			});
			expect(pds.records.size).toBe(0);
			expect(pds.callsTo("com.atproto.repo.applyWrites")).toHaveLength(0);
		});

		it("accepts securityUrl as an alternative to securityEmail", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await publishRelease(
				buildOptions(pds, {
					profile: { license: "MIT", securityUrl: "https://example.com/security" },
				}),
			);
			const profile = pds.records.get(`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`);
			const value = profile!.value as { security: Array<{ url?: string }> };
			expect(value.security[0]?.url).toBe("https://example.com/security");
		});
	});

	describe("subsequent release for an existing slug", () => {
		const wellShapedProfile = {
			$type: NSID.packageProfile,
			id: `at://${TEST_DID}/${NSID.packageProfile}/test-plugin`,
			type: "emdash-plugin",
			license: "GPL-3.0-only",
			authors: [{ name: "Original Author" }],
			security: [{ email: "old-security@example.com" }],
			slug: "test-plugin",
			lastUpdated: "2024-01-01T00:00:00.000Z",
		};

		it("preserves the existing profile's identity fields and bumps lastUpdated", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", wellShapedProfile);

			const result = await publishRelease(
				buildOptions(pds, {
					manifest: buildManifest({ version: "1.1.0" }),
					url: "https://example.com/test-plugin-1.1.0.tar.gz",
				}),
			);

			expect(result.profileCreated).toBe(false);
			expect(result.releaseOverwritten).toBe(false);
			expect(result.releaseUri).toBe(`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.1.0`);

			// Identity fields preserved -- the existing profile owns these.
			const profileNow = pds.records.get(`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`);
			const value = profileNow!.value as Record<string, unknown> & { lastUpdated: string };
			expect(value.license).toBe(wellShapedProfile.license);
			expect(value.authors).toEqual(wellShapedProfile.authors);
			expect(value.security).toEqual(wellShapedProfile.security);
			// But lastUpdated has been bumped to a fresher timestamp.
			expect(value.lastUpdated).not.toBe(wellShapedProfile.lastUpdated);
			expect(new Date(value.lastUpdated).getTime()).toBeGreaterThan(
				new Date(wellShapedProfile.lastUpdated).getTime(),
			);

			// applyWrites batch contains exactly TWO writes: profile update +
			// release create.
			const applyWrites = pds.callsTo("com.atproto.repo.applyWrites");
			expect(applyWrites).toHaveLength(1);
			const body = applyWrites[0]!.body as {
				writes: Array<{ $type: string; collection: string }>;
			};
			expect(body.writes).toHaveLength(2);
			const profileOp = body.writes.find((w) => w.collection === NSID.packageProfile);
			expect(profileOp?.$type).toBe("com.atproto.repo.applyWrites#update");
		});

		it("does not touch a malformed existing profile (just writes the release)", async () => {
			const pds = new MockPds({ did: TEST_DID });
			// Existing profile is missing required fields. We refuse to update
			// it (overwriting bad bytes with slightly-different bad bytes is
			// worse than leaving it alone) and only write the release.
			pds.seedRecord(NSID.packageProfile, "test-plugin", { incomplete: true });

			const result = await publishRelease(buildOptions(pds));
			expect(result.profileCreated).toBe(false);

			const applyWrites = pds.callsTo("com.atproto.repo.applyWrites");
			const body = applyWrites[0]!.body as {
				writes: Array<{ collection: string }>;
			};
			expect(body.writes).toHaveLength(1);
			expect(body.writes[0]?.collection).toBe(NSID.packageRelease);
		});

		it("reads existing profile and release in parallel before deciding", async () => {
			// Verifies the API issues both lookups; the actual order is
			// implementation detail (we use Promise.all). Two getRecord calls.
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", wellShapedProfile);
			await publishRelease(buildOptions(pds));
			const reads = pds.callsTo("com.atproto.repo.getRecord");
			expect(reads).toHaveLength(2);
			// Reads check both rkeys: slug (profile) and slug:version (release).
			const rkeys = reads
				.map((c) => new URL(c.pathname, "http://mock.test").searchParams.get("rkey"))
				.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
			expect(rkeys).toEqual(["test-plugin", "test-plugin:1.0.0"]);
		});

		it("reports profile fields that were ignored when reusing an existing profile", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});

			const result = await publishRelease(
				buildOptions(pds, {
					profile: {
						license: "Apache-2.0",
						authorName: "New Name",
						securityEmail: "new-security@example.com",
					},
				}),
			);

			expect(result.profileCreated).toBe(false);
			expect(result.ignoredProfileFields.toSorted()).toEqual([
				"authorName",
				"license",
				"securityEmail",
			]);
		});

		it("reports an empty ignoredProfileFields when profile is undefined", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});

			const result = await publishRelease(buildOptions(pds, { profile: undefined }));
			expect(result.profileCreated).toBe(false);
			expect(result.ignoredProfileFields).toEqual([]);
		});
	});

	describe("re-publishing an existing version", () => {
		it("refuses by default and preserves the original record bytes", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});
			const original = pds.seedRecord(NSID.packageRelease, "test-plugin:1.0.0", {
				artifacts: { package: { url: "https://old.example.com/old.tar.gz" } },
			});

			await expect(publishRelease(buildOptions(pds))).rejects.toMatchObject({
				name: "PublishError",
				code: "RELEASE_ALREADY_PUBLISHED",
			});

			// Original bytes preserved (content-derived CID is identical for
			// identical bytes).
			const releaseNow = pds.records.get(original.uri);
			expect(releaseNow?.cid).toBe(original.cid);
			expect(releaseNow?.value).toEqual(original.value);
			// applyWrites must not have been called -- the refusal is upstream.
			expect(pds.callsTo("com.atproto.repo.applyWrites")).toHaveLength(0);
		});

		it("includes slug and version in the error detail", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});
			pds.seedRecord(NSID.packageRelease, "test-plugin:1.0.0", {});

			let caught: unknown;
			try {
				await publishRelease(buildOptions(pds));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PublishError);
			expect((caught as PublishError).detail).toEqual({
				slug: "test-plugin",
				version: "1.0.0",
			});
		});

		it("overwrites the release record when allowOverwrite is true", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});
			const original = pds.seedRecord(NSID.packageRelease, "test-plugin:1.0.0", {
				artifacts: { package: { url: "https://old.example.com/old.tar.gz" } },
			});

			const result = await publishRelease(
				buildOptions(pds, {
					allowOverwrite: true,
					url: "https://example.com/new.tar.gz",
				}),
			);

			expect(result.releaseOverwritten).toBe(true);

			// Compare content directly. Mock CIDs are content-derived, so we
			// don't lean on counter increments.
			const releaseNow = pds.records.get(original.uri);
			expect(releaseNow?.value).not.toEqual(original.value);
			const value = releaseNow!.value as { artifacts: { package: { url: string } } };
			expect(value.artifacts.package.url).toBe("https://example.com/new.tar.gz");
		});

		it("issues an update operation (not create) when overwriting", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});
			pds.seedRecord(NSID.packageRelease, "test-plugin:1.0.0", {});

			await publishRelease(buildOptions(pds, { allowOverwrite: true }));

			const applyWrites = pds.callsTo("com.atproto.repo.applyWrites");
			const body = applyWrites[0]!.body as {
				writes: Array<{ $type: string; collection: string }>;
			};
			const releaseOp = body.writes.find((w) => w.collection === NSID.packageRelease);
			expect(releaseOp?.$type).toBe("com.atproto.repo.applyWrites#update");
		});
	});

	describe("synchronous validation runs before any network round-trip", () => {
		it("hard-fails on deprecated capabilities", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				manifest: buildManifest({
					capabilities: ["network:fetch", "read:content"],
				}),
			});

			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "DEPRECATED_CAPABILITY",
			});

			expect(pds.calls).toHaveLength(0);
		});

		it("hard-fails on a slug that doesn't match the lexicon constraint", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				manifest: buildManifest({ id: "Bad Plugin Name" }),
			});

			let caught: unknown;
			try {
				await publishRelease(opts);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PublishError);
			expect((caught as PublishError).code).toBe("INVALID_SLUG");
			expect(pds.calls).toHaveLength(0);
		});

		it("hard-fails on a version with build-metadata suffix", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				manifest: buildManifest({ version: "1.0.0+build.1" }),
			});

			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "INVALID_VERSION",
			});
			expect(pds.calls).toHaveLength(0);
		});

		it("hard-fails on a version with path-traversal characters", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				manifest: buildManifest({ version: "../etc/passwd" }),
			});

			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "INVALID_VERSION",
			});
			expect(pds.calls).toHaveLength(0);
		});
	});

	describe("slug derivation", () => {
		it("strips a leading @ and replaces / with - for scoped npm names", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const result = await publishRelease(
				buildOptions(pds, { manifest: buildManifest({ id: "@acme/plugin" }) }),
			);
			expect(result.slug).toBe("acme-plugin");
			expect(result.releaseUri).toContain("/acme-plugin:");
		});

		it("rejects scoped names whose translated slug starts with a non-letter", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				// `@/plugin` translates to `-plugin`, which doesn't start with a letter.
				manifest: buildManifest({ id: "@/plugin" }),
			});
			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "INVALID_SLUG",
			});
		});
	});
});
