import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const PUBLISHER_DID = "did:web:publisher.example.com";
const PAIRING_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const PAIRING_TOKEN = "T".repeat(43);
const NOW = 1_800_000_000_000;

const CLAIM = {
	repository: "example/gallery",
	repositoryId: "123456789",
	repositoryOwner: "example",
	repositoryOwnerId: "987654321",
	repositoryVisibility: "private" as const,
	workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
	ref: "refs/heads/main",
	environment: "production",
};

afterEach(async () => {
	await reset();
});

describe("GitHub workflow pairing", () => {
	it("captures signed GitHub identity and confirms an exact publishing policy", async () => {
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		const created = await publisher.createWorkflowPairing({
			publisherDid: PUBLISHER_DID,
			pairingId: PAIRING_ID,
			pairingToken: PAIRING_TOKEN,
			mutationKey: "workflow-pairing-create-0001",
			packageSlug: "gallery",
			expiresAt: NOW + 15 * 60_000,
			now: NOW,
		});
		expect(created).toMatchObject({
			ok: true,
			replayed: false,
			pairingToken: PAIRING_TOKEN,
			pairing: { state: "pending", claim: null },
		});

		await expect(
			publisher.claimWorkflowPairing({
				publisherDid: PUBLISHER_DID,
				pairingId: PAIRING_ID,
				pairingToken: "X".repeat(43),
				claim: CLAIM,
				now: NOW + 1,
			}),
		).resolves.toEqual({ ok: false, code: "PAIRING_INVALID" });

		await expect(
			publisher.claimWorkflowPairing({
				publisherDid: PUBLISHER_DID,
				pairingId: PAIRING_ID,
				pairingToken: PAIRING_TOKEN,
				claim: CLAIM,
				now: NOW + 2,
			}),
		).resolves.toMatchObject({
			ok: true,
			replayed: false,
			pairing: { state: "claimed", claim: CLAIM },
		});

		const confirmed = await publisher.confirmWorkflowPairing(PUBLISHER_DID, PAIRING_ID, NOW + 3);
		expect(confirmed).toMatchObject({
			ok: true,
			replayed: false,
			pairing: { state: "confirmed" },
			policy: {
				packageSlug: "gallery",
				repository: CLAIM.repository,
				repositoryId: CLAIM.repositoryId,
				repositoryOwnerId: CLAIM.repositoryOwnerId,
				workflowRef: CLAIM.workflowRef,
				allowedRefs: [CLAIM.ref],
				allowedEnvironments: [CLAIM.environment],
				active: true,
			},
		});
		await expect(
			publisher.confirmWorkflowPairing(PUBLISHER_DID, PAIRING_ID, NOW + 4),
		).resolves.toMatchObject({ ok: true, replayed: true });
	});

	it("replays creation and expires unconfirmed pairings", async () => {
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		const input = {
			publisherDid: PUBLISHER_DID,
			pairingId: PAIRING_ID,
			pairingToken: PAIRING_TOKEN,
			mutationKey: "workflow-pairing-create-0001",
			packageSlug: "gallery",
			expiresAt: NOW + 60_000,
			now: NOW,
		};
		await publisher.createWorkflowPairing(input);
		await expect(
			publisher.createWorkflowPairing({
				...input,
				pairingId: "01JABCDEFGHJKMNPQRSTVWXYZ1",
				pairingToken: "R".repeat(43),
				now: NOW + 1,
			}),
		).resolves.toMatchObject({
			ok: true,
			replayed: true,
			pairingToken: PAIRING_TOKEN,
			pairing: { id: PAIRING_ID },
		});
		await expect(
			publisher.getWorkflowPairing(PUBLISHER_DID, PAIRING_ID, NOW + 60_001),
		).resolves.toMatchObject({ state: "expired" });
		await expect(
			publisher.claimWorkflowPairing({
				publisherDid: PUBLISHER_DID,
				pairingId: PAIRING_ID,
				pairingToken: PAIRING_TOKEN,
				claim: CLAIM,
				now: NOW + 60_002,
			}),
		).resolves.toEqual({ ok: false, code: "PAIRING_EXPIRED" });
	});
});
