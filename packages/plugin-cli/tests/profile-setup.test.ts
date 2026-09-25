import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

import { ClientResponseError } from "@atcute/client";
import { NSID } from "@emdash-cms/registry-lexicons";
import consola from "consola";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	printProfileSetupResult,
	resolveProfileProvenance,
	resolveProfileRepository,
	runProfileSetup,
} from "../src/commands/profile.js";
import {
	PackageProfileSetupError,
	readPackageProfilePolicy,
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
const execFileAsync = promisify(execFile);

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
	afterEach(() => vi.restoreAllMocks());

	it("prefills the repository prompt from the git origin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "emdash-profile-repository-"));
		try {
			await execFileAsync("git", ["init"], { cwd: dir });
			await execFileAsync(
				"git",
				["remote", "add", "origin", "git@github.com:example/gallery.git"],
				{ cwd: dir },
			);
			const prompt = vi.fn(
				async (options: { initialValue?: string }) => options.initialValue ?? "",
			);

			await expect(
				resolveProfileRepository({
					configured: undefined,
					interactive: true,
					pluginDir: dir,
					prompt,
				}),
			).resolves.toBe(REPOSITORY);
			expect(prompt).toHaveBeenCalledWith(
				expect.objectContaining({
					initialValue: REPOSITORY,
					message: expect.stringContaining("detected"),
				}),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("asks whether provenance is required", async () => {
		const prompt = vi.fn(async () => "optional" as const);

		await expect(resolveProfileProvenance(undefined, true, undefined, prompt)).resolves.toBe(false);
		expect(prompt).toHaveBeenCalledWith(
			expect.objectContaining({
				initialValue: "required",
				message: "Should releases require verifiable build provenance?",
			}),
		);
	});

	it("defaults the provenance prompt to the current signed policy", async () => {
		const prompt = vi.fn(async () => "optional" as const);

		await expect(resolveProfileProvenance(undefined, true, false, prompt)).resolves.toBe(false);
		expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "optional" }));
	});

	it("validates non-interactive provenance modes", async () => {
		await expect(resolveProfileProvenance("required", false, false)).resolves.toBe(true);
		await expect(resolveProfileProvenance("optional", false, true)).resolves.toBe(false);
		await expect(resolveProfileProvenance(undefined, false, false)).resolves.toBe(false);
		await expect(resolveProfileProvenance("sometimes", false, undefined)).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
	});

	it("points provenance-required profiles to release workflow setup", () => {
		const success = vi.spyOn(consola, "success").mockImplementation(() => undefined);
		const info = vi.spyOn(consola, "info").mockImplementation(() => undefined);

		printProfileSetupResult(
			{ status: "created", profileUri: PROFILE_URI },
			"@publisher.example/gallery",
			"escalation-only",
			true,
			true,
		);

		expect(success).toHaveBeenCalledOnce();
		expect(stripVTControlCharacters(String(success.mock.calls[0]?.[0]))).toContain(
			"Published package profile for @publisher.example/gallery",
		);
		expect(info).toHaveBeenCalledWith("Next, configure the provenance-backed release workflow:");
		expect(info).toHaveBeenCalledWith(expect.stringContaining("emdash-plugin release setup"));
	});

	it("points optional-provenance profiles to local publishing", () => {
		const info = vi.spyOn(consola, "info").mockImplementation(() => undefined);

		printProfileSetupResult(
			{ status: "updated", profileUri: PROFILE_URI },
			"@publisher.example/gallery",
			"escalation-only",
			false,
			true,
		);

		expect(info).toHaveBeenCalledWith("Next, publish a release:");
		expect(info).toHaveBeenCalledWith(expect.stringContaining("emdash-plugin publish"));
	});

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

	it("treats a pre-delegation profile as having no current provenance policy", async () => {
		const fixture = publisher({
			cid: "bafyexisting",
			value: {
				$type: NSID.packageProfile,
				id: PROFILE_URI,
				type: "emdash-plugin",
				license: "MIT",
				authors: [{ name: "Example Publisher" }],
				security: [{ email: "security@example.com" }],
			},
		});

		await expect(readPackageProfilePolicy(fixture.publisher, "gallery")).resolves.toBeNull();
		await expect(resolveProfileProvenance(undefined, false, undefined)).resolves.toBe(true);
	});

	it("creates an optional-provenance profile when selected", async () => {
		const fixture = publisher(null);
		await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			requireProvenance: false,
			apply: true,
		});

		expect(fixture.create).toHaveBeenCalledWith(
			expect.objectContaining({
				writes: [
					expect.objectContaining({
						record: expect.objectContaining({
							extensions: {
								[NSID.packageProfileExtension]: expect.objectContaining({
									releasePolicy: expect.objectContaining({ requireProvenance: false }),
								}),
							},
						}),
					}),
				],
			}),
		);
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

	it("updates an existing provenance policy without replacing other settings", async () => {
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
						releasePolicy: {
							requireProvenance: true,
							confirmation: "always",
							approvers: ["did:plc:other"],
						},
					},
				},
			},
		});
		const result = await setupPackageProfile({
			publisher: fixture.publisher,
			slug: "gallery",
			profile: PROFILE_INPUT,
			repository: REPOSITORY,
			requireProvenance: false,
			confirmation: "always",
			apply: true,
		});

		expect(result).toMatchObject({ status: "updated", written: true });
		expect(fixture.write).toHaveBeenCalledWith(
			expect.objectContaining({
				swapRecord: "bafyexisting",
				record: expect.objectContaining({
					extensions: expect.objectContaining({
						[NSID.packageProfileExtension]: expect.objectContaining({
							releasePolicy: expect.objectContaining({
								requireProvenance: false,
								confirmation: "always",
								approvers: ["did:plc:other"],
							}),
						}),
					}),
				}),
			}),
		);
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
							releasePolicy: expect.objectContaining({
								...releasePolicy,
								requireProvenance: false,
							}),
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
