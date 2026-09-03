import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClientResponseError } from "@atcute/client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it, vi } from "vitest";

import { runProfileSetup } from "../src/commands/profile.js";
import {
	PackageProfileSetupError,
	setupPackageProfile,
	type PackageProfilePublisher,
} from "../src/profile/setup.js";

const DID = "did:plc:publisher";
const PROFILE_URI = `at://${DID}/${NSID.packageProfile}/gallery`;
const REPOSITORY = "https://github.com/example/gallery";
const PROFILE_INPUT = {
	license: "MIT",
	authors: [{ name: "Example Publisher" }],
	security: [{ email: "security@example.com" }],
	name: "Gallery",
};

function publisher(existing: { cid: string; value: unknown } | null): {
	publisher: PackageProfilePublisher;
	create: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
} {
	const create = vi.fn(async () => ({
		results: [
			{
				op: "create" as const,
				uri: PROFILE_URI,
				cid: "bafynewprofile",
				validationStatus: "unknown" as const,
			},
		],
	}));
	const write = vi.fn(async () => ({ uri: PROFILE_URI, cid: "bafynewprofile" }));
	return {
		publisher: {
			applyWrites: create,
			did: DID,
			getRecord: async () => {
				if (existing) return { uri: PROFILE_URI, ...existing };
				throw new ClientResponseError({
					status: 400,
					data: { error: "RecordNotFound", message: "Record not found" },
				});
			},
			unsafePutRecord: write,
		},
		create,
		write,
	};
}

describe("package profile setup", () => {
	it("turns setup dependency failures into a clean command error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "emdash-profile-command-"));
		try {
			await expect(runProfileSetup({ dir, yes: true })).rejects.toMatchObject({
				name: "PackageProfileSetupError",
				code: "INVALID_INPUT",
				message: expect.stringContaining("emdash-plugin.jsonc"),
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("creates a missing profile from manifest metadata and a safe default release policy", async () => {
		const fixture = publisher(null);
		const result = await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			apply: true,
			now: () => new Date("2026-09-03T10:00:00.000Z"),
		});

		expect(result).toMatchObject({ status: "created", written: true, profileUri: PROFILE_URI });
		expect(fixture.create).toHaveBeenCalledWith({
			writes: [
				{
					op: "create",
					collection: NSID.packageProfile,
					rkey: "gallery",
					record: expect.objectContaining({
						$type: NSID.packageProfile,
						id: PROFILE_URI,
						license: "MIT",
						name: "Gallery",
						extensions: {
							[NSID.packageProfileExtension]: {
								$type: NSID.packageProfileExtension,
								repository: REPOSITORY,
								releasePolicy: {
									$type: `${NSID.packageProfileExtension}#releasePolicy`,
									approvers: [DID],
									confirmation: "escalation-only",
									requireProvenance: true,
								},
							},
						},
					}),
				},
			],
			skipValidation: true,
		});
	});

	it("adds delegated release settings to an existing valid profile without replacing metadata", async () => {
		const existing = {
			$type: NSID.packageProfile,
			id: PROFILE_URI,
			type: "emdash-plugin",
			license: "Apache-2.0",
			authors: [{ name: "Existing Author" }],
			security: [{ email: "existing@example.com" }],
			name: "Existing name",
			extensions: { "example.com/other": { retained: true } },
		};
		const fixture = publisher({ cid: "bafyexisting", value: existing });
		await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			apply: true,
		});

		expect(fixture.write).toHaveBeenCalledWith(
			expect.objectContaining({
				swapRecord: "bafyexisting",
				record: expect.objectContaining({
					license: "Apache-2.0",
					name: "Existing name",
					extensions: expect.objectContaining({
						"example.com/other": { retained: true },
					}),
				}),
			}),
		);
	});

	it("does not rewrite a profile that already links the same repository", async () => {
		const fixture = publisher({
			cid: "bafyexisting",
			value: {
				$type: NSID.packageProfile,
				id: PROFILE_URI,
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Example Publisher" }],
				security: [{ email: "security@example.com" }],
				extensions: {
					[NSID.packageProfileExtension]: {
						$type: NSID.packageProfileExtension,
						repository: REPOSITORY,
						releasePolicy: { confirmation: "always", approvers: ["did:plc:other"] },
					},
				},
			},
		});
		const result = await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			apply: true,
		});

		expect(result).toMatchObject({ status: "ready", written: false });
		expect(fixture.write).not.toHaveBeenCalled();
	});

	it("canonicalizes an equivalent repository without replacing its release policy", async () => {
		const releasePolicy = { confirmation: "always", approvers: ["did:plc:other"] };
		const fixture = publisher({
			cid: "bafyexisting",
			value: {
				$type: NSID.packageProfile,
				id: PROFILE_URI,
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Example Publisher" }],
				security: [{ email: "security@example.com" }],
				extensions: {
					[NSID.packageProfileExtension]: {
						repository: `${REPOSITORY}/`,
						releasePolicy,
					},
				},
			},
		});
		const result = await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			apply: true,
		});

		expect(result).toMatchObject({ status: "updated", written: true });
		expect(fixture.write).toHaveBeenCalledWith(
			expect.objectContaining({
				record: expect.objectContaining({
					extensions: expect.objectContaining({
						[NSID.packageProfileExtension]: expect.objectContaining({
							repository: REPOSITORY,
							releasePolicy,
						}),
					}),
				}),
			}),
		);
	});

	it("refuses to silently replace a different signed repository", async () => {
		const fixture = publisher({
			cid: "bafyexisting",
			value: {
				$type: NSID.packageProfile,
				id: PROFILE_URI,
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Example Publisher" }],
				security: [{ email: "security@example.com" }],
				extensions: {
					[NSID.packageProfileExtension]: {
						repository: "https://github.com/example/other",
					},
				},
			},
		});

		await expect(
			setupPackageProfile({
				publisher: fixture.publisher,
				slug: "gallery",
				profile: PROFILE_INPUT,
				repository: REPOSITORY,
				apply: true,
			}),
		).rejects.toMatchObject<Partial<PackageProfileSetupError>>({
			code: "REPOSITORY_MISMATCH",
		});
		expect(fixture.write).not.toHaveBeenCalled();
	});
});
