import { decode, decodeFirst, fromBytes, isBytes } from "@atcute/cbor";
import { parseSignedListingLabel, verifyListingLabel } from "@emdash-cms/registry-moderation";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
	createLabelPublicationTarget,
	LABEL_SUBSCRIPTION_DO_NAME,
	publishPendingLabels,
} from "../src/subscriptions/publisher.js";
import {
	createTestIssuer,
	decisionContext,
	PROFILE_SUBJECT,
	PROFILE_URI,
} from "./issuer-helpers.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("com.atproto.label.subscribeLabels", () => {
	it("replays retained D1 history in order and resumes after a reconnect cursor", async () => {
		const issuer = await createTestIssuer(env.DB);
		const first = await issuer.approve(decisionContext("replay-first"), PROFILE_SUBJECT);
		const second = await issuer.block(decisionContext("replay-second"), PROFILE_SUBJECT);
		const history = [...first.labels, ...second.labels];

		const replay = await connect(0);
		const replayed = await collectFrames(replay, history.length);
		expect(replayed.map((frame) => frame.sequence)).toEqual(history.map((label) => label.sequence));
		replay.close(1000, "reconnect");

		const third = await issuer.approve(decisionContext("replay-third"), PROFILE_SUBJECT);
		const resumed = await connect(second.labels.at(-1)!.sequence);
		expect((await collectFrames(resumed, 1))[0]?.sequence).toBe(third.labels[0]!.sequence);
		resumed.close(1000, "done");
	});

	it("delivers live notifications and repairs publication with the D1 backstop", async () => {
		const target = createLabelPublicationTarget(env.LABEL_SUBSCRIPTION_DO);
		const issuer = await createTestIssuer(env.DB);
		await issuer.approve(decisionContext("live-baseline"), PROFILE_SUBJECT);

		const healthy = await connect();
		const liveFrame = collectFrames(healthy, 1);
		const pending = await issuer.approve(decisionContext("live-pending"), PROFILE_SUBJECT);
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM issued_labels WHERE publication_pending = 1",
		).first<{ count: number }>();
		const result = await publishPendingLabels(env.DB, target);
		expect(result).toEqual({ attempted: before?.count, accepted: before?.count, failed: 0 });
		expect((await liveFrame)[0]?.sequence).toBe(pending.labels[0]!.sequence);

		const stored = await env.DB.prepare(
			"SELECT publication_pending FROM issued_labels WHERE sequence = ?",
		)
			.bind(pending.labels.at(-1)!.sequence)
			.first<{ publication_pending: number }>();
		expect(stored?.publication_pending).toBe(0);
		healthy.close(1000, "done");
	});

	it("isolates a disconnected subscriber from live issuance", async () => {
		const target = createLabelPublicationTarget(env.LABEL_SUBSCRIPTION_DO);
		const issuer = await createTestIssuer(env.DB, { publicationTarget: target });
		const failed = await connect();
		const healthy = await connect();
		failed.accept();
		failed.close(1011, "simulated failure");
		const received = collectFrames(healthy, 1);
		const issued = await issuer.approve(decisionContext("isolated-subscriber"), PROFILE_SUBJECT);
		expect((await received)[0]?.sequence).toBe(issued.labels[0]!.sequence);
		expect(issued.labels.every((label) => !label.publicationPending)).toBe(true);
		healthy.close(1000, "done");
	});

	it("refreshes earlier delivery state after a later notification succeeds", async () => {
		const liveTarget = createLabelPublicationTarget(env.LABEL_SUBSCRIPTION_DO);
		let calls = 0;
		const issuer = await createTestIssuer(env.DB, {
			publicationTarget: {
				async notify(sequence) {
					calls++;
					if (calls === 1) throw new Error("transient publication failure");
					await liveTarget.notify(sequence);
				},
			},
		});
		const decision = await issuer.approve(decisionContext("delivery-refresh"), {
			...PROFILE_SUBJECT,
			uri: `${PROFILE_SUBJECT.uri}-delivery-refresh`,
		});
		expect(decision.labels).toHaveLength(2);
		expect(decision.labels.every((label) => !label.publicationPending)).toBe(true);
	});

	it("rejects malformed cursors before upgrading", async () => {
		const stub = env.LABEL_SUBSCRIPTION_DO.getByName(LABEL_SUBSCRIPTION_DO_NAME);
		const response = await stub.fetch("https://labeler.test/subscribe?cursor=-1", {
			headers: { upgrade: "websocket" },
		});
		expect(response.status).toBe(400);
		expect(response.webSocket).toBeNull();
	});

	it("re-signs subscription replay with the current key without rewriting history", async () => {
		const before = await env.DB.prepare(
			"SELECT COALESCE(MAX(sequence), 0) AS sequence FROM issued_labels",
		).first<{ sequence: number }>();
		const uri = `${PROFILE_URI}-subscription-key-rotation`;
		const storedSignature = new Uint8Array(64).fill(0x6b);
		await env.DB.prepare(
			`INSERT INTO issued_labels
			 (idempotency_key, actor_did, actor_role, reason, ver, src, uri, cid, val,
			  neg, cts, exp, sig, signing_key_id, publication_pending, created_at)
			 VALUES (?, ?, 'reviewer', 'Retained rotation fixture', 1, ?, ?, ?,
			         'listing-review', 0, ?, NULL, ?, 'old-key', 0, ?)`,
		)
			.bind(
				"subscription-key-rotation",
				env.LABELER_DID,
				env.LABELER_DID,
				uri,
				PROFILE_SUBJECT.cid,
				"2026-08-24T12:00:00.000Z",
				storedSignature,
				"2026-08-24T12:00:00.000Z",
			)
			.run();

		const socket = await connect(before?.sequence ?? 0);
		const frame = (await collectFrames(socket, 1))[0];
		socket.close(1000, "done");
		const replayed = parseSubscriptionLabel(frame?.labels[0]);
		await expect(
			verifyListingLabel({
				label: replayed,
				resolveDid: async () => ({
					id: env.LABELER_DID,
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: env.LABELER_DID,
							publicKeyMultibase: env.LABEL_SIGNING_PUBLIC_KEY,
						},
					],
				}),
			}),
		).resolves.toBeDefined();
		expect([...replayed.sig]).not.toEqual([...storedSignature]);
		const stored = await env.DB.prepare(
			"SELECT sig, signing_key_id FROM issued_labels WHERE idempotency_key = ?",
		)
			.bind("subscription-key-rotation")
			.first<{ sig: ArrayBuffer; signing_key_id: string }>();
		expect([...new Uint8Array(stored!.sig)]).toEqual([...storedSignature]);
		expect(stored?.signing_key_id).toBe("old-key");
	});
});

async function connect(cursor?: number): Promise<WebSocket> {
	const stub = env.LABEL_SUBSCRIPTION_DO.getByName(LABEL_SUBSCRIPTION_DO_NAME);
	const suffix = cursor === undefined ? "" : `?cursor=${cursor}`;
	const response = await stub.fetch(`https://labeler.test/subscribe${suffix}`, {
		headers: { upgrade: "websocket" },
	});
	expect(response.status).toBe(101);
	const socket = response.webSocket;
	if (!socket) throw new Error("subscription did not return a WebSocket");
	return socket;
}

interface DecodedFrame {
	header: Record<string, unknown>;
	sequence: number;
	labels: unknown[];
}

function collectFrames(socket: WebSocket, count: number): Promise<DecodedFrame[]> {
	return new Promise((resolve, reject) => {
		const frames: DecodedFrame[] = [];
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for label frames")),
			2_000,
		);
		const onMessage = async (event: MessageEvent) => {
			try {
				frames.push(await decodeFrame(event.data));
				if (frames.length === count) {
					clearTimeout(timeout);
					resolve(frames);
				}
			} catch (error) {
				clearTimeout(timeout);
				reject(error);
			}
		};
		socket.addEventListener("message", (event) => {
			void onMessage(event);
		});
		socket.addEventListener("error", () => {
			clearTimeout(timeout);
			reject(new Error("subscription socket failed"));
		});
		socket.accept();
	});
}

async function decodeFrame(data: unknown): Promise<DecodedFrame> {
	const bytes =
		data instanceof ArrayBuffer
			? new Uint8Array(data)
			: data instanceof Uint8Array
				? data
				: data instanceof Blob
					? new Uint8Array(await data.arrayBuffer())
					: failUnexpectedFrame();
	const [headerValue, payloadBytes] = decodeFirst(bytes);
	const payloadValue: unknown = decode(payloadBytes);
	const header = asRecord(headerValue, "header");
	const payload = asRecord(payloadValue, "payload");
	if (typeof payload["seq"] !== "number" || !Array.isArray(payload["labels"])) {
		throw new TypeError("invalid label subscription payload");
	}
	return { header, sequence: payload["seq"], labels: payload["labels"] };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${field} must be an object`);
	}
	return Object.fromEntries(
		Object.keys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]),
	);
}

function failUnexpectedFrame(): never {
	throw new TypeError("subscription frame must be binary");
}

function parseSubscriptionLabel(value: unknown) {
	const record = asRecord(value, "label");
	const signature = record["sig"];
	if (!isBytes(signature)) throw new TypeError("subscription label signature is invalid");
	return parseSignedListingLabel({ ...record, sig: fromBytes(signature) });
}
