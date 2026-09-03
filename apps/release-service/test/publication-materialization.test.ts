import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { IntentState, PutWorkloadPolicyInput } from "../src/publisher-do/publisher-do.js";

const DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const SOURCE_DIGEST = "B".repeat(43);
const NOW = 1_800_000_000_000;
const CHECKSUM = "bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a";
const BLOB_CID = "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q";

type TestArtifactSlot = "icon" | "package" | "screenshots[0]" | "screenshots[1]";

interface TestArtifact {
	url?: string;
	checksum: string;
	contentType?: string;
	width?: number;
	height?: number;
	blob?: {
		$type: "blob";
		ref: { $link: string };
		mimeType: string;
		size: number;
	};
}

interface TestRelease {
	$type: "com.emdashcms.experimental.package.release";
	package: string;
	version: string;
	artifacts: {
		package: TestArtifact;
		icon?: TestArtifact;
		screenshots?: TestArtifact[];
	};
}

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

function policy(): PutWorkloadPolicyInput {
	return {
		publisherDid: DID,
		packageSlug: "gallery",
		repository: "emdash-cms/gallery",
		repositoryId: "123",
		repositoryOwnerId: "456",
		workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: [],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW,
	};
}

function sourceUrl(slot: TestArtifactSlot): string {
	return `https://example.com/${slot.replaceAll("[", "-").replaceAll("]", "")}`;
}

function sourceRelease(slots: readonly TestArtifactSlot[]): TestRelease {
	const descriptor = (slot: TestArtifactSlot): TestArtifact => ({
		url: sourceUrl(slot),
		checksum: CHECKSUM,
		contentType: slot === "package" ? "application/gzip" : "image/png",
		...(slot === "package" ? {} : { width: 640, height: 480 }),
	});
	return {
		$type: "com.emdashcms.experimental.package.release" as const,
		package: "gallery",
		version: "1.2.3",
		artifacts: {
			package: descriptor("package"),
			...(slots.includes("icon") ? { icon: descriptor("icon") } : {}),
			...(slots.includes("screenshots[0]")
				? {
						screenshots: slots
							.filter((slot) => slot.startsWith("screenshots"))
							.map((slot) => descriptor(slot)),
					}
				: {}),
		},
	};
}

function materializedRelease(slots: readonly TestArtifactSlot[]): TestRelease {
	const release = structuredClone(sourceRelease(slots));
	const withBlob = (slot: TestArtifactSlot): TestArtifact => {
		const descriptor = structuredClone(
			slot === "package"
				? release.artifacts.package
				: slot === "icon"
					? release.artifacts.icon!
					: release.artifacts.screenshots![Number(slot.at(-2))],
		);
		if (!descriptor) throw new Error("Missing test artifact descriptor");
		delete descriptor.url;
		return {
			...descriptor,
			blob: {
				$type: "blob" as const,
				ref: { $link: BLOB_CID },
				mimeType: slot === "package" ? "application/gzip" : "image/png",
				size: slot === "package" ? 32_768 : 4_096,
			},
		};
	};
	release.artifacts.package = withBlob("package");
	if (release.artifacts.icon) release.artifacts.icon = withBlob("icon");
	if (release.artifacts.screenshots) {
		release.artifacts.screenshots = release.artifacts.screenshots.map((_, index) =>
			withBlob(`screenshots[${index}]` as TestArtifactSlot),
		);
	}
	return release;
}

async function prepareReadyIntent(
	slots: readonly TestArtifactSlot[] = ["package"],
	release: TestRelease = sourceRelease(slots),
) {
	const stub = publisher();
	await stub.putWorkloadPolicy(policy());
	await stub.createIntent({
		publisherDid: DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: SOURCE_DIGEST,
		workloadIdentityJson: '{"issuer":"github-actions"}',
		releaseInputJson: JSON.stringify({ release }),
		expiresAt: NOW + 60_000,
		now: NOW + 1,
	});
	const path = ["verifying", "verified", "ready"] as const;
	let state: IntentState = "received";
	let generation = 1;
	for (const next of path) {
		await stub.transitionIntent({
			publisherDid: DID,
			intentId: INTENT_ID,
			expectedState: state,
			expectedGeneration: generation,
			toState: next,
			transitionDigest: String.fromCharCode(66 + generation).repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: JSON.stringify({ step: next }),
			...(next === "verifying" ? { workflowId: "workflow-1" } : {}),
			now: NOW + 1 + generation,
		});
		state = next;
		generation += 1;
	}
	return stub;
}

async function stage(slot: TestArtifactSlot) {
	const image = slot !== "package";
	return {
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest: SOURCE_DIGEST,
		slot,
		sourceUrlDigest: await digest(sourceUrl(slot)),
		checksum: CHECKSUM,
		stagingKey: `publication/${INTENT_ID}/${slot.replace("[", "-").replace("]", "")}`,
		mimeType: image ? ("image/png" as const) : ("application/gzip" as const),
		size: image ? 4_096 : 32_768,
		width: image ? 640 : null,
		height: image ? 480 : null,
		now: NOW + 10,
	};
}

async function receipt(slot: TestArtifactSlot) {
	const staged = await stage(slot);
	return {
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest: SOURCE_DIGEST,
		slot,
		blob: {
			$type: "blob" as const,
			ref: { $link: BLOB_CID },
			mimeType: staged.mimeType,
			size: staged.size,
		},
		now: NOW + 11,
	};
}

async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

afterEach(async () => {
	await reset();
});

describe("publisher publication materialization", () => {
	it("replays exact mutations, rejects conflicts, and lists slots canonically", async () => {
		const stub = await prepareReadyIntent(["package", "icon", "screenshots[0]", "screenshots[1]"]);
		await expect(
			stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4),
		).resolves.toEqual({ ok: true, replayed: false });
		await expect(
			stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 5),
		).resolves.toEqual({ ok: true, replayed: true });
		await expect(
			stub.beginPublicationMaterialization(DID, INTENT_ID, "Z".repeat(43), NOW + 5),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });

		for (const slot of ["screenshots[1]", "package", "icon", "screenshots[0]"] as const) {
			const staged = await stage(slot);
			const blobReceipt = await receipt(slot);
			await expect(stub.putPublicationArtifactStage(staged)).resolves.toEqual({
				ok: true,
				replayed: false,
			});
			await expect(stub.putPublicationArtifactStage(staged)).resolves.toEqual({
				ok: true,
				replayed: true,
			});
			await expect(stub.putPublicationBlobReceipt(blobReceipt)).resolves.toEqual({
				ok: true,
				replayed: false,
			});
			await expect(stub.putPublicationBlobReceipt(blobReceipt)).resolves.toEqual({
				ok: true,
				replayed: true,
			});
		}
		const packageStage = await stage("package");
		const packageReceipt = await receipt("package");
		await expect(
			stub.putPublicationArtifactStage({ ...packageStage, size: 32_769 }),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationBlobReceipt({
					...packageReceipt,
					blob: { ...packageReceipt.blob, size: 1 },
				}),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
		});

		await expect(stub.getPublicationMaterialization(DID, INTENT_ID)).resolves.toMatchObject({
			intentId: INTENT_ID,
			sourceDigest: SOURCE_DIGEST,
			status: "preparing",
			slots: [
				{ slot: "package", blob: expect.objectContaining({ mimeType: "application/gzip" }) },
				{ slot: "icon", blob: expect.objectContaining({ mimeType: "image/png" }) },
				{ slot: "screenshots[0]" },
				{ slot: "screenshots[1]" },
			],
		});
	});

	it("writes one bounded canonical final record after every slot has a receipt", async () => {
		const stub = await prepareReadyIntent();
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		await stub.putPublicationArtifactStage(await stage("package"));
		const recordJson = JSON.stringify(materializedRelease(["package"]));
		const recordDigest = await digest(recordJson);
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest,
				now: NOW + 12,
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_INCOMPLETE" });
		const packageReceipt = await receipt("package");
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationBlobReceipt({
					...packageReceipt,
					blob: {
						...packageReceipt.blob,
						ref: {
							$link: "bafkreibm6jg3ux5qu5wzvikphw4qjzx6i7htc4w4e4c4pv7a7uynxqevmy",
						},
					},
				}),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
		});
		await stub.putPublicationBlobReceipt(packageReceipt);

		const complete = {
			publisherDid: DID,
			intentId: INTENT_ID,
			sourceDigest: SOURCE_DIGEST,
			recordJson,
			recordDigest,
			now: NOW + 12,
		};
		await expect(stub.completePublicationMaterialization(complete)).resolves.toEqual({
			ok: true,
			replayed: false,
		});
		await expect(stub.completePublicationMaterialization(complete)).resolves.toEqual({
			ok: true,
			replayed: true,
		});
		await expect(
			stub.completePublicationMaterialization({
				...complete,
				recordJson: JSON.stringify({ ...materializedRelease(["package"]), package: "other" }),
				recordDigest: await digest(
					JSON.stringify({ ...materializedRelease(["package"]), package: "other" }),
				),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
		await expect(stub.getPublicationMaterialization(DID, INTENT_ID)).resolves.toMatchObject({
			status: "complete",
			recordJson,
			recordDigest,
		});
	});

	it("rejects a final record whose blob does not match its staged receipt", async () => {
		const stub = await prepareReadyIntent();
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		await stub.putPublicationArtifactStage(await stage("package"));
		await stub.putPublicationBlobReceipt(await receipt("package"));
		const substituted = materializedRelease(["package"]);
		substituted.artifacts.package.blob!.ref.$link =
			"bafkreibm6jg3ux5qu5wzvikphw4qjzx6i7htc4w4e4c4pv7a7uynxqevmy";
		const recordJson = JSON.stringify(substituted);

		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
	});

	it("requires the staged and final slots to equal the immutable source slots", async () => {
		let stub = await prepareReadyIntent(["package", "icon"]);
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		await stub.putPublicationArtifactStage(await stage("package"));
		await stub.putPublicationBlobReceipt(await receipt("package"));
		let recordJson = JSON.stringify(materializedRelease(["package", "icon"]));
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_INCOMPLETE" });
		await stub.putPublicationArtifactStage(await stage("icon"));
		await stub.putPublicationBlobReceipt(await receipt("icon"));
		recordJson = JSON.stringify(materializedRelease(["package"]));
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });

		await reset();
		stub = await prepareReadyIntent();
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		for (const slot of ["package", "icon"] as const) {
			await stub.putPublicationArtifactStage(await stage(slot));
			await stub.putPublicationBlobReceipt(await receipt(slot));
		}
		recordJson = JSON.stringify(materializedRelease(["package", "icon"]));
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
	});

	it("requires the verified MIME type in the canonical record", async () => {
		const source = sourceRelease(["package"]);
		delete source.artifacts.package.contentType;
		const stub = await prepareReadyIntent(["package"], source);
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		await stub.putPublicationArtifactStage(await stage("package"));
		await stub.putPublicationBlobReceipt(await receipt("package"));
		const missingContentType = materializedRelease(["package"]);
		delete missingContentType.artifacts.package.contentType;
		let recordJson = JSON.stringify(missingContentType);
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });

		recordJson = JSON.stringify(materializedRelease(["package"]));
		await expect(
			stub.completePublicationMaterialization({
				publisherDid: DID,
				intentId: INTENT_ID,
				sourceDigest: SOURCE_DIGEST,
				recordJson,
				recordDigest: await digest(recordJson),
			}),
		).resolves.toEqual({ ok: true, replayed: false });
	});

	it("rejects out-of-range slots, staged sizes, and final JSON", async () => {
		const stub = await prepareReadyIntent();
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		const packageStage = await stage("package");
		const screenshotStage = await stage("screenshots[0]");
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationArtifactStage({ ...packageStage, size: 262_145 }),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
			expect(() =>
				instance.putPublicationArtifactStage({
					...screenshotStage,
					// @ts-expect-error - verifies runtime rejection outside the static slot union
					slot: "screenshots[8]",
				}),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
		});
		await stub.putPublicationArtifactStage(packageStage);
		await stub.putPublicationBlobReceipt(await receipt("package"));
		const invalidRecordJson = '{"package":"gallery","version":"1.2.3"}';
		await runInDurableObject(stub, async (instance) => {
			await expect(
				instance.completePublicationMaterialization({
					publisherDid: DID,
					intentId: INTENT_ID,
					sourceDigest: SOURCE_DIGEST,
					recordJson: invalidRecordJson,
					recordDigest: await digest(invalidRecordJson),
				}),
			).rejects.toMatchObject({ code: "PUBLICATION_MATERIALIZATION_INVALID" });
		});
		const oversizedJson = JSON.stringify({ value: "x".repeat(128 * 1024) });
		await runInDurableObject(stub, async (instance) => {
			await expect(
				instance.completePublicationMaterialization({
					publisherDid: DID,
					intentId: INTENT_ID,
					sourceDigest: SOURCE_DIGEST,
					recordJson: oversizedJson,
					recordDigest: await digest(oversizedJson),
				}),
			).rejects.toMatchObject({ code: "PUBLICATION_MATERIALIZATION_INVALID" });
		});
	});
});
