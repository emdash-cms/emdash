/**
 * Coverage for the programmatic `updatePackage` API.
 *
 * Runs against the in-memory `MockPds` rather than a real PDS so the
 * publish/update boundary is exercised against the same atproto contract
 * the publish tests use.
 */

import { PublishingClient } from "@emdash-cms/registry-client";
import type { Did } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import {
	buildPackageCandidate,
	updatePackage,
	UpdatePackageError,
	type PackageUpdateInput,
} from "../src/update-package/api.js";
import { MockPds } from "./mock-pds.js";

const TEST_DID: Did = "did:plc:test123";
const SLUG = "test-plugin";

function buildPublisher(pds: MockPds): PublishingClient {
	return PublishingClient.fromHandler({
		handler: pds,
		did: pds.did,
		pds: "http://mock.test",
	});
}

function seedProfile(
	pds: MockPds,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const record: Record<string, unknown> = {
		$type: NSID.packageProfile,
		id: `at://${TEST_DID}/${NSID.packageProfile}/${SLUG}`,
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Alice" }],
		security: [{ email: "security@example.com" }],
		slug: SLUG,
		lastUpdated: "2024-01-01T00:00:00.000Z",
		...overrides,
	};
	pds.seedRecord(NSID.packageProfile, SLUG, record);
	return record;
}

function input(overrides: Partial<PackageUpdateInput> = {}): PackageUpdateInput {
	return {
		license: "MIT",
		authors: [{ name: "Alice" }],
		security: [{ email: "security@example.com" }],
		...overrides,
	};
}

const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");
const now = () => FIXED_NOW;

describe("updatePackage", () => {
	describe("dry-run", () => {
		it("returns an empty diff when manifest matches the existing profile", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input(),
				now,
			});

			expect(result.diffs).toEqual([]);
			expect(result.written).toBe(false);
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("detects a license change without writing", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({ license: "Apache-2.0" }),
				now,
			});

			expect(result.written).toBe(false);
			expect(result.diffs).toEqual([{ field: "license", before: "MIT", after: "Apache-2.0" }]);
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("detects a name-only change", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds, { name: "Old Name" });

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({ name: "New Name" }),
				now,
			});

			expect(result.diffs).toEqual([{ field: "name", before: "Old Name", after: "New Name" }]);
		});

		it("treats keywords reordering as a diff (arrays are ordered)", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds, { keywords: ["a", "b"] });

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({ keywords: ["b", "a"] }),
				now,
			});

			expect(result.diffs).toEqual([{ field: "keywords", before: ["a", "b"], after: ["b", "a"] }]);
		});

		it("detects multi-field changes (description, keywords, authors)", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds, {
				description: "old description",
				keywords: ["one"],
			});

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({
					description: "new description",
					keywords: ["one", "two"],
					authors: [{ name: "Alice", url: "https://alice.example.com" }, { name: "Bob" }],
				}),
				now,
			});

			expect(result.written).toBe(false);
			const fields = result.diffs.map((d) => d.field).toSorted();
			expect(fields).toEqual(["authors", "description", "keywords"]);
		});

		it("preserves an optional field that the manifest omits (no silent deletion)", async () => {
			// Mirrors publish semantics: a missing-from-manifest key isn't a
			// request to delete. Without this, accidentally removing the
			// `description` line in emdash-plugin.jsonc would silently wipe
			// a value the publisher put on the record.
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds, { description: "old description" });

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input(),
				now,
			});

			expect(result.diffs).toEqual([]);
			expect((result.candidate as { description?: string }).description).toBe("old description");
		});
	});

	describe("apply", () => {
		it("writes the candidate via putRecord and bumps lastUpdated when there are diffs", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({ license: "Apache-2.0" }),
				apply: true,
				now,
			});

			expect(result.written).toBe(true);
			const puts = pds.callsTo("com.atproto.repo.putRecord");
			expect(puts).toHaveLength(1);
			const body = puts[0]!.body as {
				repo: string;
				collection: string;
				rkey: string;
				record: Record<string, unknown>;
				validate?: boolean;
				swapRecord?: string;
			};
			expect(body.repo).toBe(TEST_DID);
			expect(body.collection).toBe(NSID.packageProfile);
			expect(body.rkey).toBe(SLUG);
			expect(body.validate).toBe(false);
			// Optimistic concurrency: the write carries the CID we read,
			// so a concurrent edit between read and write surfaces as
			// STALE_RECORD instead of silently winning.
			expect(typeof body.swapRecord).toBe("string");
			expect(body.swapRecord).not.toBe("");
			expect(body.record.license).toBe("Apache-2.0");
			expect(body.record.lastUpdated).toBe(FIXED_NOW.toISOString());
			// Identity fields preserved verbatim.
			expect(body.record.$type).toBe(NSID.packageProfile);
			expect(body.record.id).toBe(`at://${TEST_DID}/${NSID.packageProfile}/${SLUG}`);
			expect(body.record.slug).toBe(SLUG);
			expect(body.record.type).toBe("emdash-plugin");
		});

		it("does NOT write when there are no diffs, even with apply:true", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			const result = await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input(),
				apply: true,
				now,
			});

			expect(result.written).toBe(false);
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("preserves unknown forward-compatible fields on the existing record", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds, {
				sections: { description: "long-form text" },
				someFutureField: { nested: true },
			});

			await updatePackage({
				publisher: buildPublisher(pds),
				slug: SLUG,
				input: input({ license: "Apache-2.0" }),
				apply: true,
				now,
			});

			const stored = pds.records.get(`at://${TEST_DID}/${NSID.packageProfile}/${SLUG}`);
			const value = stored!.value as Record<string, unknown>;
			expect(value.sections).toEqual({ description: "long-form text" });
			expect(value.someFutureField).toEqual({ nested: true });
		});
	});

	describe("refusals", () => {
		it("throws PACKAGE_NOT_FOUND when no record exists at the slug and no other profile is found", async () => {
			const pds = new MockPds({ did: TEST_DID });
			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input(),
				}),
			).rejects.toMatchObject({
				name: "UpdatePackageError",
				code: "PACKAGE_NOT_FOUND",
			});
		});

		it("throws POSSIBLE_RENAME listing every other package when the slug is missing", async () => {
			const pds = new MockPds({ did: TEST_DID });
			// Publisher already has THREE packages under other slugs. The
			// diagnostic should list all of them — a publisher with multiple
			// plugins shouldn't see a misleading "you might have renamed X"
			// pointer at an unrelated package.
			for (const slug of ["alpha", "beta", "gamma"]) {
				pds.seedRecord(NSID.packageProfile, slug, {
					$type: NSID.packageProfile,
					id: `at://${TEST_DID}/${NSID.packageProfile}/${slug}`,
					type: "emdash-plugin",
					license: "MIT",
					authors: [{ name: "Alice" }],
					security: [{ email: "security@example.com" }],
					slug,
					lastUpdated: "2024-01-01T00:00:00.000Z",
				});
			}

			let caught: unknown;
			try {
				await updatePackage({
					publisher: buildPublisher(pds),
					slug: "new-slug",
					input: input(),
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(UpdatePackageError);
			const err = caught as UpdatePackageError;
			expect(err.code).toBe("POSSIBLE_RENAME");
			expect(err.message).toContain("alpha");
			expect(err.message).toContain("beta");
			expect(err.message).toContain("gamma");
			expect(err.detail).toMatchObject({
				existingSlugs: expect.arrayContaining(["alpha", "beta", "gamma"]),
			});
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("rethrows auth failures from the sibling scan instead of degrading to PACKAGE_NOT_FOUND", async () => {
			// Mock a PDS that returns AuthRequired on listRecords. The
			// rename-detection path should surface the real cause so the
			// user is prompted to re-login rather than seeing a confusing
			// PACKAGE_NOT_FOUND that didn't actually check.
			const pds = new MockPds({ did: TEST_DID });
			const wrappedHandle = pds.handle.bind(pds);
			pds.handle = async (pathname, init) => {
				if (pathname.includes("listRecords")) {
					return new Response(
						JSON.stringify({ error: "AuthRequired", message: "session expired" }),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				}
				return wrappedHandle(pathname, init);
			};

			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input(),
				}),
			).rejects.toMatchObject({ error: "AuthRequired" });
		});

		it("throws STALE_RECORD when the record changes between read and write", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);
			// Intercept putRecord to simulate a concurrent edit having
			// changed the record's CID. A real PDS returns InvalidSwap in
			// this case.
			const wrappedHandle = pds.handle.bind(pds);
			pds.handle = async (pathname, init) => {
				if (pathname.includes("putRecord")) {
					return new Response(
						JSON.stringify({
							error: "InvalidSwap",
							message: "Record was modified",
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				return wrappedHandle(pathname, init);
			};

			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input({ license: "Apache-2.0" }),
					apply: true,
					now,
				}),
			).rejects.toMatchObject({
				name: "UpdatePackageError",
				code: "STALE_RECORD",
			});
		});

		it("throws INVALID_INPUT when authors is empty", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input({ authors: [] }),
					apply: true,
				}),
			).rejects.toMatchObject({
				name: "UpdatePackageError",
				code: "INVALID_INPUT",
			});

			// Fails before any network access — no read, no write.
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
			expect(pds.callsTo("com.atproto.repo.getRecord")).toHaveLength(0);
		});

		it("throws INVALID_INPUT when a security entry has neither url nor email", async () => {
			const pds = new MockPds({ did: TEST_DID });
			seedProfile(pds);

			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input({ security: [{}] }),
					apply: true,
				}),
			).rejects.toMatchObject({
				name: "UpdatePackageError",
				code: "INVALID_INPUT",
			});
		});

		it("throws PACKAGE_INVALID when the existing record fails lexicon validation", async () => {
			const pds = new MockPds({ did: TEST_DID });
			pds.seedRecord(NSID.packageProfile, SLUG, { incomplete: true });

			await expect(
				updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input(),
				}),
			).rejects.toMatchObject({
				name: "UpdatePackageError",
				code: "PACKAGE_INVALID",
			});

			// And nothing was written.
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});

		it("throws SLUG_MISMATCH when the existing record's slug disagrees with the manifest's", async () => {
			const pds = new MockPds({ did: TEST_DID });
			// Seed at the manifest's rkey but with a different slug field. A
			// real aggregator would reject this; we refuse to make it worse.
			seedProfile(pds, { slug: "different-slug" });

			let caught: unknown;
			try {
				await updatePackage({
					publisher: buildPublisher(pds),
					slug: SLUG,
					input: input({ license: "Apache-2.0" }),
					apply: true,
				});
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(UpdatePackageError);
			expect((caught as UpdatePackageError).code).toBe("SLUG_MISMATCH");
			expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
		});
	});
});

describe("buildPackageCandidate", () => {
	it("does not bump lastUpdated when there are no diffs", () => {
		const existing = {
			$type: NSID.packageProfile,
			license: "MIT",
			authors: [{ name: "Alice" }],
			security: [{ email: "security@example.com" }],
			slug: SLUG,
			type: "emdash-plugin",
			lastUpdated: "2024-01-01T00:00:00.000Z",
		};
		const { candidate, diffs } = buildPackageCandidate({
			existing,
			input: input(),
			now: FIXED_NOW,
		});
		expect(diffs).toEqual([]);
		expect(candidate.lastUpdated).toBe("2024-01-01T00:00:00.000Z");
	});

	it("bumps lastUpdated only when there are diffs", () => {
		const existing = {
			$type: NSID.packageProfile,
			license: "MIT",
			authors: [{ name: "Alice" }],
			security: [{ email: "security@example.com" }],
			slug: SLUG,
			type: "emdash-plugin",
			lastUpdated: "2024-01-01T00:00:00.000Z",
		};
		const { candidate, diffs } = buildPackageCandidate({
			existing,
			input: input({ license: "Apache-2.0" }),
			now: FIXED_NOW,
		});
		expect(diffs).toHaveLength(1);
		expect(candidate.lastUpdated).toBe(FIXED_NOW.toISOString());
	});

	it("treats deeply-equal author lists as no change", () => {
		const existing = {
			$type: NSID.packageProfile,
			license: "MIT",
			authors: [{ name: "Alice", url: "https://alice.example.com" }],
			security: [{ email: "security@example.com" }],
			slug: SLUG,
			type: "emdash-plugin",
			lastUpdated: "2024-01-01T00:00:00.000Z",
		};
		const { diffs } = buildPackageCandidate({
			existing,
			input: input({
				authors: [{ name: "Alice", url: "https://alice.example.com" }],
			}),
			now: FIXED_NOW,
		});
		expect(diffs).toEqual([]);
	});

	it("writes changed sections and preserves them when the manifest omits them", () => {
		const existing = {
			$type: NSID.packageProfile,
			license: "MIT",
			authors: [{ name: "Alice" }],
			security: [{ email: "security@example.com" }],
			slug: SLUG,
			type: "emdash-plugin",
			sections: { description: "Old description." },
			lastUpdated: "2024-01-01T00:00:00.000Z",
		};

		const updated = buildPackageCandidate({
			existing,
			input: input({ sections: { description: "New description.", faq: "Q & A." } }),
			now: FIXED_NOW,
		});
		expect(updated.candidate.sections).toEqual({
			description: "New description.",
			faq: "Q & A.",
		});
		expect(updated.diffs.map((d) => d.field)).toContain("sections");

		const preserved = buildPackageCandidate({
			existing,
			input: input(),
			now: FIXED_NOW,
		});
		expect(preserved.candidate.sections).toEqual({ description: "Old description." });
		expect(preserved.diffs.map((d) => d.field)).not.toContain("sections");
	});
});
