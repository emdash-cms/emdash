import { decodeFirst, fromBytes } from "@atcute/cbor";
import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { issueManualLabel, type AllowedLabelProposal } from "../src/service.js";
import { createLabelPublisher, type LabelPublisher } from "../src/subscribe-labels.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:example:labeler";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const config = { labelerDid: LABELER_DID };
let actionNumber = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function releaseUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

function profileUri(name: string): string {
	return `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/${name}`;
}

function action(reason: string) {
	actionNumber++;
	return {
		actor: "did:example:moderator",
		type: "manual-label" as const,
		reason,
		idempotencyKey: `test-${actionNumber}`,
	};
}

function proposal(uri: string, val: AllowedLabelProposal["val"] = "security-yanked") {
	return { uri, val };
}

function document(did = LABELER_DID): LabelDidDocument {
	return {
		id: did,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: did,
				publicKeyMultibase: MULTIKEY,
			},
		],
	};
}

async function signer() {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(),
	});
}

async function foreignSigner() {
	const issuerDid = "did:example:foreign";
	return createLabelSigner({
		issuerDid,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => document(issuerDid),
	});
}

async function issue(uri: string, val?: AllowedLabelProposal["val"], neg = false, publish = false) {
	return issueManualLabel(
		testEnv.DB,
		config,
		await signer(),
		action(`test issue ${actionNumber + 1}`),
		{
			...proposal(uri, val),
			...(neg ? { neg: true } : {}),
		},
		undefined,
		publish ? createLabelPublisher(testEnv as unknown as Env) : undefined,
	);
}

async function subscribe(cursor?: number): Promise<WebSocket> {
	const response = await SELF.fetch(
		`https://test/xrpc/com.atproto.label.subscribeLabels${cursor === undefined ? "" : `?cursor=${cursor}`}`,
		{ headers: { upgrade: "websocket" } },
	);
	expect(response.status).toBe(101);
	if (!response.webSocket) throw new Error("subscription did not upgrade to a WebSocket");
	response.webSocket.accept();
	return response.webSocket;
}

async function nextLabel(ws: WebSocket): Promise<{ seq: number; label: Record<string, unknown> }> {
	const message = await nextMessage(ws);
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

async function nextMessage(ws: WebSocket): Promise<ArrayBuffer> {
	return new Promise<ArrayBuffer>((resolve) => {
		ws.addEventListener("message", (event) => resolve(event.data as ArrayBuffer), { once: true });
	});
}

async function nextMessageWithin(ws: WebSocket, milliseconds: number): Promise<ArrayBuffer | null> {
	return Promise.race([
		nextMessage(ws),
		new Promise<null>((resolve) => setTimeout(resolve, milliseconds, null)),
	]);
}

describe("manual label issuance", () => {
	it("issues a signed label that the public query returns without a secret", async () => {
		const uri = releaseUri("round-trip");
		const issued = await issue(uri);

		const response = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			labels: Array<{
				sig: { $bytes: string };
				src: string;
				uri: string;
				val: string;
				cts: string;
			}>;
		};
		expect(body.labels).toHaveLength(1);
		expect(body.labels[0]).toMatchObject({ src: LABELER_DID, uri, val: "security-yanked" });

		const returned = body.labels[0]!;
		await expect(
			verifyLabel({
				label: { ...returned, ver: 1, sig: fromBase64(returned.sig.$bytes) },
				resolveDid: async () => document(),
			}),
		).resolves.toMatchObject({ src: LABELER_DID, uri, val: "security-yanked" });
		expect(issued.signingKeyId).toBe(`${LABELER_DID}#atproto_label`);
	});

	it("allocates monotonically increasing sequences", async () => {
		const first = await issue(releaseUri("sequence-a"));
		const second = await issue(releaseUri("sequence-b"));
		expect(second.sequence).toBeGreaterThan(first.sequence);
	});

	it("returns the original signed label for a duplicate action", async () => {
		const labelSigner = await signer();
		const originalAction = action("idempotent issue");
		const input = proposal(releaseUri("idempotent"));
		const first = await issueManualLabel(testEnv.DB, config, labelSigner, originalAction, input);
		const second = await issueManualLabel(testEnv.DB, config, labelSigner, originalAction, input);
		expect(second.sequence).toBe(first.sequence);
		expect(second.label).toEqual(first.label);
		const count = await testEnv.DB.prepare(
			`SELECT COUNT(*) AS count FROM issued_labels l
				 JOIN issuance_actions a ON a.id = l.action_id
				 WHERE a.idempotency_key = ?`,
		)
			.bind(originalAction.idempotencyKey)
			.first<{ count: number }>();
		expect(count?.count).toBe(1);
	});

	it("retries publishing a committed label through an idempotent request", async () => {
		const labelSigner = await signer();
		const originalAction = action("retry publish");
		const input = proposal(releaseUri("retry-publish"));
		const failedPublisher: LabelPublisher = {
			async publish() {
				throw new Error("subscription unavailable");
			},
		};
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				labelSigner,
				originalAction,
				input,
				undefined,
				failedPublisher,
			),
		).rejects.toThrow("subscription unavailable");

		let published = 0;
		const retryPublisher: LabelPublisher = {
			async publish() {
				published++;
			},
		};
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				labelSigner,
				originalAction,
				input,
				undefined,
				retryPublisher,
			),
		).resolves.toBeDefined();
		expect(published).toBe(1);
	});

	it("records a later negation as a new signed history entry", async () => {
		const uri = releaseUri("negation");
		const active = await issue(uri, "security-yanked");
		const negated = await issue(uri, "security-yanked", true);
		expect(negated.sequence).toBeGreaterThan(active.sequence);

		const response = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
		);
		const body = (await response.json()) as { labels: Array<{ neg?: boolean }> };
		expect(body.labels).toHaveLength(2);
		expect(body.labels.map((label) => label.neg === true)).toEqual([false, true]);
	});

	it("enforces the manual proposal subject table", async () => {
		await expect(issue(PUBLISHER_DID, "!takedown")).resolves.toBeDefined();
		await expect(issue(profileUri("disputed"), "package-disputed")).resolves.toBeDefined();
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("CID takedown"), {
				uri: releaseUri("exact-cid"),
				cid: CID,
				val: "!takedown",
			}),
		).rejects.toThrow("!takedown must not include a CID");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("CID security yank"), {
				uri: releaseUri("yanked-cid"),
				cid: CID,
				val: "security-yanked",
			}),
		).rejects.toThrow("security-yanked must not include a CID");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid disputed release"), {
				uri: releaseUri("not-disputed"),
				val: "package-disputed",
			}),
		).rejects.toThrow("package profile");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid yanked package"), {
				uri: profileUri("not-yanked"),
				val: "security-yanked",
			}),
		).rejects.toThrow("release record");
	});

	it("rejects a signer that is not bound to the configured labeler DID", async () => {
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				await foreignSigner(),
				action("foreign signer"),
				proposal(releaseUri("foreign-signer")),
			),
		).rejects.toThrow("configured labeler DID");
	});

	it("allows only signature metadata rotation after sequence allocation", async () => {
		const issued = await issue(releaseUri("key-rotation"));
		await expect(
			testEnv.DB.prepare("UPDATE issued_labels SET sig = ?, signing_key_id = ? WHERE sequence = ?")
				.bind(issued.label.sig, "did:example:labeler#rotated", issued.sequence)
				.run(),
		).resolves.toBeDefined();
		await expect(
			testEnv.DB.prepare("UPDATE issued_labels SET val = ? WHERE sequence = ?")
				.bind("package-disputed", issued.sequence)
				.run(),
		).rejects.toThrow("issued labels are immutable");
	});

	it("filters URI prefixes and sources, then paginates in sequence order", async () => {
		const base = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/paging-`;
		await issue(`${base}a:1.0.0`);
		await issue(`${base}b:1.0.0`);
		await issue(`${base}c:1.0.0`);
		const first = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=${LABELER_DID}&limit=2`,
		);
		const firstBody = (await first.json()) as { labels: Array<{ uri: string }>; cursor: string };
		expect(firstBody.labels).toHaveLength(2);
		expect(firstBody.cursor).toBeTruthy();
		const second = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=${LABELER_DID}&limit=2&cursor=${firstBody.cursor}`,
		);
		const secondBody = (await second.json()) as { labels: Array<{ uri: string }>; cursor?: string };
		expect(secondBody.labels).toHaveLength(1);
		expect(secondBody.cursor).toBeUndefined();
		const wrongSource = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(`${base}*`)}&sources=did:example:other`,
		);
		expect(((await wrongSource.json()) as { labels: unknown[] }).labels).toEqual([]);
	});

	it("rejects invalid issuance and query input", async () => {
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid subject"), {
				uri: "https://example.com/not-a-subject",
				val: "security-yanked",
			}),
		).rejects.toThrow("security-yanked must target a release record");
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), action("invalid publisher CID"), {
				uri: PUBLISHER_DID,
				cid: CID,
				val: "publisher-compromised",
			}),
		).rejects.toThrow("publisher-compromised");
		const missingPatterns = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?limit=2",
		);
		expect(missingPatterns.status).toBe(400);
		const badCursor = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=at%3A%2F%2Fdid%3Aexample%3Aone%2F*&cursor=0",
		);
		expect(badCursor.status).toBe(400);
		const methodNotAllowed = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=did%3Aexample%3Atest",
			{ method: "POST" },
		);
		expect(methodNotAllowed.status).toBe(405);
		expect(methodNotAllowed.headers.get("allow")).toBe("GET");
		expect(await methodNotAllowed.json()).toMatchObject({ error: "MethodNotSupported" });
		const unknown = await SELF.fetch("https://test/xrpc/com.example.unknown");
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: "MethodNotSupported" });
	});
});

describe("label subscriptions", () => {
	it("replays retained history from cursor zero with ATProto event framing", async () => {
		const issued = await issue(releaseUri("subscription-replay"));
		const ws = await subscribe(0);
		let event: { seq: number; label: Record<string, unknown> } | undefined;
		for (;;) {
			event = await nextLabel(ws);
			if (event.seq === issued.sequence) break;
		}
		expect(event.label).toMatchObject({
			src: LABELER_DID,
			uri: issued.label.uri,
			val: "security-yanked",
		});
		expect(fromBytes(event.label.sig as { $bytes: string })).toEqual(issued.label.sig);
		ws.close();
	});

	it("resumes after a cursor and broadcasts newly committed labels", async () => {
		const first = await issue(releaseUri("subscription-resume-a"));
		const second = await issue(releaseUri("subscription-resume-b"));
		const ws = await subscribe(first.sequence);
		expect((await nextLabel(ws)).seq).toBe(second.sequence);
		const liveEvent = nextLabel(ws);
		const issued = await issue(releaseUri("subscription-resume-live"), undefined, false, true);
		expect((await liveEvent).seq).toBe(issued.sequence);
		ws.close();
	});

	it("does not lose a label at the replay and live handoff", async () => {
		const before = await issue(releaseUri("subscription-race-before"));
		const socket = subscribe(before.sequence);
		const committed = issue(releaseUri("subscription-race-commit"), undefined, false, true);
		const ws = await socket;
		const event = await nextLabel(ws);
		expect(event.seq).toBe((await committed).sequence);
		ws.close();
	});

	it("does not duplicate a replayed label when its publish is delayed", async () => {
		const before = await issue(releaseUri("subscription-duplicate-before"));
		const delayed = await issue(releaseUri("subscription-duplicate"));
		const ws = await subscribe(before.sequence);
		expect((await nextLabel(ws)).seq).toBe(delayed.sequence);

		const duplicate = nextMessageWithin(ws, 100);
		await createLabelPublisher(testEnv as unknown as Env).publish(delayed);
		expect(await duplicate).toBeNull();
		ws.close();
	});

	it("delivers committed labels in sequence order when publication is delayed", async () => {
		const ws = await subscribe();
		const first = await issue(releaseUri("subscription-order-first"));
		const next = nextLabel(ws);
		const published = issue(releaseUri("subscription-order-second"), undefined, false, true);
		expect((await next).seq).toBe(first.sequence);
		const second = await published;
		expect((await nextLabel(ws)).seq).toBe(second.sequence);

		const duplicate = nextMessageWithin(ws, 100);
		await createLabelPublisher(testEnv as unknown as Env).publish(first);
		expect(await duplicate).toBeNull();
		ws.close();
	});

	it("starts without replay when no cursor is supplied and supports reconnect cursors", async () => {
		const ws = await subscribe();
		const currentEvent = nextLabel(ws);
		const issued = await issue(releaseUri("subscription-current"), undefined, false, true);
		expect((await currentEvent).seq).toBe(issued.sequence);
		ws.close();

		const resumed = await subscribe(issued.sequence);
		const nextEvent = nextLabel(resumed);
		const next = await issue(releaseUri("subscription-reconnect"), undefined, false, true);
		expect((await nextEvent).seq).toBe(next.sequence);
		resumed.close();
	});

	it("broadcasts to more subscribers than the scheduler queue limit", async () => {
		const sockets = await Promise.all(Array.from({ length: 101 }, () => subscribe()));
		const events = sockets.map((socket) => nextLabel(socket));
		const issued = await issue(releaseUri("subscription-fanout"), undefined, false, true);
		expect(await Promise.all(events)).toEqual(
			Array.from({ length: 101 }, () => expect.objectContaining({ seq: issued.sequence })),
		);
		for (const socket of sockets) socket.close();
	});

	it("returns XRPC errors for malformed subscription requests", async () => {
		const noUpgrade = await SELF.fetch("https://test/xrpc/com.atproto.label.subscribeLabels");
		expect(noUpgrade.status).toBe(426);
		expect(await noUpgrade.json()).toMatchObject({ error: "InvalidRequest" });
		const malformedCursor = await SELF.fetch(
			"https://test/xrpc/com.atproto.label.subscribeLabels?cursor=-1",
			{ headers: { upgrade: "websocket" } },
		);
		expect(malformedCursor.status).toBe(400);
		expect(await malformedCursor.json()).toMatchObject({ error: "InvalidRequest" });
		const wrongMethod = await SELF.fetch("https://test/xrpc/com.atproto.label.subscribeLabels", {
			method: "POST",
		});
		expect(wrongMethod.status).toBe(405);
		expect(await wrongMethod.json()).toMatchObject({ error: "MethodNotSupported" });
	});

	it("returns a FutureCursor stream error when the cursor is ahead of history", async () => {
		const ws = await subscribe(Number.MAX_SAFE_INTEGER);
		const message = await nextMessageWithin(ws, 100);
		expect(message).not.toBeNull();
		const [header, payload] = decodeFirst(new Uint8Array(message!)) as [{ op: number }, Uint8Array];
		expect(header).toEqual({ op: -1 });
		expect(decodeFirst(payload)[0]).toMatchObject({ error: "FutureCursor" });
		ws.close();
	});
});

function fromBase64(value: string): Uint8Array {
	const decoded = atob(value);
	return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
