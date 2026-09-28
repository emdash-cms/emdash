import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import { createEnvelopeEncryption } from "../src/crypto/encryption.js";
import { startEncryptionVerificationWorkflow } from "../src/workflows/encryption-verification.js";

const PUBLISHER_DID = "did:plc:encryption-workflow-v2";
const KEYRING_V1 =
	'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}';
const ADMIN = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
} as const satisfies AccessActor;

async function directoryShard(did: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did)),
	);
	return digest[0]!.toString(16).padStart(2, "0");
}

afterEach(async () => {
	await reset();
});

describe("EncryptionVerificationWorkflow key rotation", () => {
	it("rotates retained version-one ciphertext and verifies version two", async () => {
		const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
		await control.setServiceMode({
			actor: ADMIN,
			idempotencyKey: "encryption-workflow-v2-pause",
			requestDigest: "P".repeat(43),
			mode: "publication-paused",
			reasonCode: "KEY_ROTATION",
		});
		await control.activateEncryptionKey({
			actor: ADMIN,
			idempotencyKey: "encryption-workflow-v2-activate",
			requestDigest: "A".repeat(43),
			version: 2,
		});
		const configuration = await loadConfiguration(env);
		const context = {
			purpose: "oauth-session",
			objectClass: "PublisherDurableObject",
			table: "delegation",
			primaryKey: "1",
			ownerDid: PUBLISHER_DID,
		} as const;
		const retained = await createEnvelopeEncryption(KEYRING_V1, configuration.deploymentId).encrypt(
			new TextEncoder().encode("retained-session"),
			context,
		);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: configuration.oauth.releaseNsid,
			scope: configuration.oauth.releaseScope,
			clientKeyId: configuration.oauth.activeAssertionKeyId,
			encryptedSession: retained.envelope,
			encryptionKeyVersion: retained.keyVersion,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});
		await env.IDENTITY_DIRECTORY_DO.getByName(await directoryShard(PUBLISHER_DID)).register(
			"publisher",
			PUBLISHER_DID,
		);

		const started = await startEncryptionVerificationWorkflow(
			env.ENCRYPTION_VERIFICATION_WORKFLOW,
			{
				campaignId: "encryption-verification-v2-0001",
				targetKeyVersion: 2,
				retiringKeyVersion: 1,
				actorIdentity: ADMIN.identity,
			},
		);
		expect(started).toMatchObject({ ok: true, created: true });
		if (!started.ok) return;
		const instance = await env.ENCRYPTION_VERIFICATION_WORKFLOW.get(started.workflowId);
		let status = await instance.status();
		for (let attempt = 0; attempt < 2_000 && status.status !== "complete"; attempt += 1) {
			if (status.status === "errored" || status.status === "terminated") break;
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			status = await instance.status();
		}

		expect(status.status, JSON.stringify(status.error)).toBe("complete");
		expect(status.output).toMatchObject({
			targetKeyVersion: 2,
			retiringKeyVersion: 1,
			publishers: 1,
			records: 1,
			rotated: 1,
		});
		await expect(publisher.listEncryptionRecords(PUBLISHER_DID, null, 100)).resolves.toMatchObject({
			items: [{ keyVersion: 2 }],
		});
	}, 30_000);
});
