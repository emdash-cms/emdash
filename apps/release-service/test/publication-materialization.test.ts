import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { IntentState, PutWorkloadPolicyInput } from "../src/publisher-do/publisher-do.js";

const DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const SOURCE_DIGEST = "B".repeat(43);
const NOW = 1_800_000_000_000;

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

async function prepareReadyIntent() {
	const stub = publisher();
	await stub.putWorkloadPolicy(policy());
	await stub.createIntent({
		publisherDid: DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: SOURCE_DIGEST,
		workloadIdentityJson: '{"issuer":"github-actions"}',
		releaseInputJson: '{"package":"gallery","version":"1.2.3"}',
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

function stage(slot: "icon" | "package" | "screenshots[0]" | "screenshots[1]") {
	const image = slot !== "package";
	return {
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest: SOURCE_DIGEST,
		slot,
		sourceUrlDigest: `${slot[0]!.toUpperCase()}${"U".repeat(42)}`,
		checksum: "bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a",
		stagingKey: `publication/${INTENT_ID}/${slot.replace("[", "-").replace("]", "")}`,
		mimeType: image ? ("image/png" as const) : ("application/gzip" as const),
		size: image ? 4_096 : 32_768,
		width: image ? 640 : null,
		height: image ? 480 : null,
		now: NOW + 10,
	};
}

function receipt(slot: "icon" | "package" | "screenshots[0]" | "screenshots[1]") {
	const staged = stage(slot);
	return {
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest: SOURCE_DIGEST,
		slot,
		blob: {
			$type: "blob" as const,
			ref: { $link: "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q" },
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
		const stub = await prepareReadyIntent();
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
			await expect(stub.putPublicationArtifactStage(stage(slot))).resolves.toEqual({
				ok: true,
				replayed: false,
			});
			await expect(stub.putPublicationArtifactStage(stage(slot))).resolves.toEqual({
				ok: true,
				replayed: true,
			});
			await expect(stub.putPublicationBlobReceipt(receipt(slot))).resolves.toEqual({
				ok: true,
				replayed: false,
			});
			await expect(stub.putPublicationBlobReceipt(receipt(slot))).resolves.toEqual({
				ok: true,
				replayed: true,
			});
		}
		await expect(
			stub.putPublicationArtifactStage({ ...stage("package"), size: 32_769 }),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationBlobReceipt({
					...receipt("package"),
					blob: { ...receipt("package").blob, size: 1 },
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
		await stub.putPublicationArtifactStage(stage("package"));
		const recordJson = '{"package":"gallery","version":"1.2.3"}';
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
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationBlobReceipt({
					...receipt("package"),
					blob: {
						...receipt("package").blob,
						ref: {
							$link: "bafkreibm6jg3ux5qu5wzvikphw4qjzx6i7htc4w4e4c4pv7a7uynxqevmy",
						},
					},
				}),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
		});
		await stub.putPublicationBlobReceipt(receipt("package"));

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
				recordJson: '{"package":"other","version":"1.2.3"}',
				recordDigest: await digest('{"package":"other","version":"1.2.3"}'),
			}),
		).resolves.toEqual({ ok: false, code: "MATERIALIZATION_CONFLICT" });
		await expect(stub.getPublicationMaterialization(DID, INTENT_ID)).resolves.toMatchObject({
			status: "complete",
			recordJson,
			recordDigest,
		});
	});

	it("rejects out-of-range slots, staged sizes, and final JSON", async () => {
		const stub = await prepareReadyIntent();
		await stub.beginPublicationMaterialization(DID, INTENT_ID, SOURCE_DIGEST, NOW + 4);
		await runInDurableObject(stub, (instance) => {
			expect(() =>
				instance.putPublicationArtifactStage({ ...stage("package"), size: 262_145 }),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
			expect(() =>
				instance.putPublicationArtifactStage({
					...stage("screenshots[0]"),
					// @ts-expect-error - verifies runtime rejection outside the static slot union
					slot: "screenshots[8]",
				}),
			).toThrowError(expect.objectContaining({ code: "PUBLICATION_MATERIALIZATION_INVALID" }));
		});
		await stub.putPublicationArtifactStage(stage("package"));
		await stub.putPublicationBlobReceipt(receipt("package"));
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
