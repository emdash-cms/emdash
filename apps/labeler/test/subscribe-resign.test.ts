import { decodeFirst, fromBytes } from "@atcute/cbor";
import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
	type SignedLabel,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { initializeSigningState } from "../src/signing-rotation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const ACTIVE_MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const RETIRED_PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI";
const RETIRED_MULTIKEY = "zDnaer52RTwabaBeMkKYYwZmEFqPabLW78cRK62iovMUQhFif";

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	// The worker env signs v1 with ACTIVE_MULTIKEY, so the active signing key here
	// matches the deployment config the subscription DO re-signs with.
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: ACTIVE_MULTIKEY,
	});
});

function retiredDocument(): LabelDidDocument {
	return {
		id: LABELER_DID,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: LABELER_DID,
				publicKeyMultibase: RETIRED_MULTIKEY,
			},
		],
	};
}

function activeDocument(): LabelDidDocument {
	return {
		id: LABELER_DID,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: LABELER_DID,
				publicKeyMultibase: ACTIVE_MULTIKEY,
			},
		],
	};
}

/** Persists a label signed with the retired key at a stale key version, exactly
 * the shape a routine rotation leaves behind in retained history. */
async function seedRetiredKeyLabel(uri: string): Promise<number> {
	const signer = await createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: RETIRED_PRIVATE_KEY,
		resolveDid: async () => retiredDocument(),
	});
	const cts = new Date().toISOString();
	const unsigned = { ver: 1, uri, val: "security-yanked", cts } as const;
	const returned = await signer.sign(unsigned);
	const idempotencyKey = `resign-seed-${uri}`;
	await testEnv.DB.prepare(
		`INSERT INTO issuance_actions (actor, type, reason, idempotency_key, created_at)
		 VALUES (?, 'manual-label', 'retired-key seed', ?, ?)`,
	)
		.bind(LABELER_DID, idempotencyKey, cts)
		.run();
	await testEnv.DB.prepare(
		`INSERT INTO issued_labels
		 (action_id, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
		  signing_key_version, publication_pending)
		 SELECT id, 1, ?, ?, NULL, 'security-yanked', 0, ?, NULL, ?, ?, 'v0', 0
		 FROM issuance_actions WHERE idempotency_key = ?`,
	)
		.bind(LABELER_DID, uri, cts, returned.sig, `${LABELER_DID}#atproto_label`, idempotencyKey)
		.run();
	const row = await testEnv.DB.prepare(
		`SELECT sequence FROM issued_labels l JOIN issuance_actions a ON a.id = l.action_id
		 WHERE a.idempotency_key = ?`,
	)
		.bind(idempotencyKey)
		.first<{ sequence: number }>();
	return row!.sequence;
}

async function subscribe(cursor: number): Promise<WebSocket> {
	const response = await SELF.fetch(
		`https://test/xrpc/com.atproto.label.subscribeLabels?cursor=${cursor}`,
		{ headers: { upgrade: "websocket" } },
	);
	expect(response.status).toBe(101);
	if (!response.webSocket) throw new Error("subscription did not upgrade to a WebSocket");
	response.webSocket.accept();
	return response.webSocket;
}

function decodeLabel(message: ArrayBuffer): {
	seq: number;
	label: Record<string, unknown>;
} {
	const [header, payload] = decodeFirst(new Uint8Array(message)) as [
		{ op: number; t: string },
		Uint8Array,
	];
	expect(header).toEqual({ op: 1, t: "#labels" });
	const event = decodeFirst(payload)[0] as { seq: number; labels: Record<string, unknown>[] };
	const label = event.labels[0];
	if (!label) throw new Error("labels event did not contain a label");
	return { seq: event.seq, label };
}

async function nextLabelWithSeq(ws: WebSocket, seq: number): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		const listener = (event: MessageEvent) => {
			const decoded = decodeLabel(event.data as ArrayBuffer);
			if (decoded.seq !== seq) return;
			ws.removeEventListener("message", listener);
			resolve(decoded.label);
		};
		ws.addEventListener("message", listener);
	});
}

describe("subscription replay re-signs retired-key labels (Finding 5)", () => {
	it("delivers a replayed frame that verifies under the active key and persists the re-sign", async () => {
		const uri = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/resign-replay:1.0.0`;
		const sequence = await seedRetiredKeyLabel(uri);

		const ws = await subscribe(sequence - 1);
		const frame = await nextLabelWithSeq(ws, sequence);
		ws.close();

		const label: SignedLabel = {
			ver: 1,
			src: String(frame.src),
			uri: String(frame.uri),
			val: String(frame.val),
			cts: String(frame.cts),
			sig: fromBytes(frame.sig as { $bytes: string }),
		};
		// The replayed frame no longer verifies under the retired key...
		await expect(
			verifyLabel({ label, resolveDid: async () => retiredDocument() }),
		).rejects.toThrow();
		// ...it verifies under the active (published) key a fresh aggregator would use.
		await expect(
			verifyLabel({ label, resolveDid: async () => activeDocument() }),
		).resolves.toMatchObject({ uri, val: "security-yanked" });

		// The re-sign is persisted, so the work is not repeated per connection.
		const persisted = await testEnv.DB.prepare(
			`SELECT signing_key_version FROM issued_labels WHERE sequence = ?`,
		)
			.bind(sequence)
			.first<{ signing_key_version: string }>();
		expect(persisted?.signing_key_version).toBe("v1");
	});
});
