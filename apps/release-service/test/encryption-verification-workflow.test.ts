import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import { startEncryptionVerificationWorkflow } from "../src/workflows/encryption-verification.js";

const PUBLISHER_DID = "did:plc:encryption-workflow-publisher";
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

describe("EncryptionVerificationWorkflow", () => {
	it("verifies every directory partition and records the active key proof", async () => {
		const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
		await control.setServiceMode({
			actor: ADMIN,
			idempotencyKey: "encryption-workflow-pause-0001",
			requestDigest: "P".repeat(43),
			mode: "publication-paused",
			reasonCode: "KEY_ROTATION",
		});
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).initializePublisher(PUBLISHER_DID);
		await env.IDENTITY_DIRECTORY_DO.getByName(await directoryShard(PUBLISHER_DID)).register(
			"publisher",
			PUBLISHER_DID,
		);

		const started = await startEncryptionVerificationWorkflow(
			env.ENCRYPTION_VERIFICATION_WORKFLOW,
			{
				campaignId: "encryption-verification-0001",
				targetKeyVersion: 1,
				retiringKeyVersion: null,
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
			targetKeyVersion: 1,
			retiringKeyVersion: null,
			publishers: 1,
			approvers: 0,
			records: 0,
			rotated: 0,
		});
		await expect(control.readEncryptionVerification(ADMIN, 1)).resolves.toMatchObject({
			workflowId: started.workflowId,
			publishers: 1,
			approvers: 0,
		});
	}, 30_000);
});
