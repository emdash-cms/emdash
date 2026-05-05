import { describe, expect, it } from "vitest";

import { PublishingClient } from "@emdash-cms/registry-client";
import type { Did } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import type { PluginManifest } from "@emdash-cms/plugin-types";

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

function buildOptions(
	pds: MockPds,
	overrides: Partial<PublishOptions> = {},
): PublishOptions {
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
			expect(result.profileUri).toBe(
				`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`,
			);
			expect(result.releaseUri).toBe(
				`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.0.0`,
			);

			// Both records should be in the mock PDS.
			expect(pds.records.size).toBe(2);
			expect(pds.records.has(result.profileUri)).toBe(true);
			expect(pds.records.has(result.releaseUri)).toBe(true);
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

			const profile = pds.records.get(
				`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`,
			);
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

			const release = pds.records.get(
				`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.0.0`,
			);
			expect(release).toBeDefined();
			const value = release!.value as {
				package: string;
				version: string;
				artifacts: { package: { url: string; checksum: string; contentType?: string } };
			};
			expect(value.package).toBe("test-plugin");
			expect(value.version).toBe("1.0.0");
			expect(value.artifacts.package.url).toBe(
				"https://example.com/test-plugin-1.0.0.tar.gz",
			);
			expect(value.artifacts.package.checksum).toBe("bciqtestchecksum");
			expect(value.artifacts.package.contentType).toBe("application/gzip");
		});

		it("hard-fails when license is missing", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, {
				profile: { securityEmail: "security@example.com" },
			});
			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "PROFILE_BOOTSTRAP_MISSING_FIELD",
			});
			// No records should have been written -- the failure happens in the
			// profile-build step before any putRecord calls.
			expect(pds.records.size).toBe(0);
		});

		it("hard-fails when both securityEmail and securityUrl are missing", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const opts = buildOptions(pds, { profile: { license: "MIT" } });
			await expect(publishRelease(opts)).rejects.toMatchObject({
				name: "PublishError",
				code: "PROFILE_BOOTSTRAP_MISSING_FIELD",
			});
			expect(pds.records.size).toBe(0);
		});

		it("accepts securityUrl as an alternative to securityEmail", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await publishRelease(
				buildOptions(pds, {
					profile: { license: "MIT", securityUrl: "https://example.com/security" },
				}),
			);
			const profile = pds.records.get(
				`at://${TEST_DID}/${NSID.packageProfile}/test-plugin`,
			);
			const value = profile!.value as { security: Array<{ url?: string }> };
			expect(value.security[0]?.url).toBe("https://example.com/security");
		});
	});

	describe("subsequent release for an existing slug", () => {
		it("reuses the existing profile and writes a new release record", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const seededProfile = pds.seedRecord(NSID.packageProfile, "test-plugin", {
				$type: NSID.packageProfile,
				license: "GPL-3.0-only",
				authors: [{ name: "Original Author" }],
				security: [{ email: "old-security@example.com" }],
			});

			const result = await publishRelease(
				buildOptions(pds, {
					manifest: buildManifest({ version: "1.1.0" }),
					url: "https://example.com/test-plugin-1.1.0.tar.gz",
				}),
			);

			expect(result.profileCreated).toBe(false);
			expect(result.releaseOverwritten).toBe(false);
			expect(result.releaseUri).toBe(
				`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.1.0`,
			);

			// Profile record bytes are unchanged: the existing CID is preserved.
			const profileNow = pds.records.get(seededProfile.uri);
			expect(profileNow?.cid).toBe(seededProfile.cid);
			expect(profileNow?.value).toEqual(seededProfile.value);

			// Release record was written.
			expect(pds.records.has(result.releaseUri)).toBe(true);
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
		it("refuses by default and does not overwrite the release record", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, "test-plugin", {});
			const original = pds.seedRecord(NSID.packageRelease, "test-plugin:1.0.0", {
				artifacts: { package: { url: "https://old.example.com/old.tar.gz" } },
			});

			await expect(publishRelease(buildOptions(pds))).rejects.toMatchObject({
				name: "PublishError",
				code: "RELEASE_ALREADY_PUBLISHED",
			});

			// Original release bytes must be preserved.
			const releaseNow = pds.records.get(original.uri);
			expect(releaseNow?.cid).toBe(original.cid);
			expect(releaseNow?.value).toEqual(original.value);
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

		it("overwrites and signals it when allowOverwrite is true", async () => {
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

			// Bytes have been replaced. CID gets reissued by the mock on every
			// putRecord, so it must differ from the original.
			const releaseNow = pds.records.get(original.uri);
			expect(releaseNow?.cid).not.toBe(original.cid);
			const value = releaseNow!.value as {
				artifacts: { package: { url: string } };
			};
			expect(value.artifacts.package.url).toBe("https://example.com/new.tar.gz");
		});
	});

	describe("deprecated capabilities", () => {
		it("hard-fails before any network round-trip", async () => {
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

			// No XRPC calls should have been issued -- the check runs first.
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
	});
});
