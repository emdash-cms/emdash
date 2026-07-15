import { decodeFirst, fromBytes } from "@atcute/cbor";
import {
	createLabelSigner,
	verifyLabel,
	type LabelDidDocument,
	type LabelSigner,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { getLabelerIdentityConfig } from "../src/config.js";
import { queryLabels } from "../src/query-labels.js";
import { issueManualLabel, type AllowedLabelProposal } from "../src/service.js";
import {
	activateRoutineKeyRotation,
	abortRoutineKeyRotation,
	beginRoutineKeyRotation,
	getSigningStatus,
	initializeSigningState,
	listSigningAlerts,
} from "../src/signing-rotation.js";
import { createRuntimeSigner } from "../src/signing-runtime.js";
import { createLabelPublisher, type LabelPublisher } from "../src/subscribe-labels.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const LABELER_SERVICE_URL = "https://labels.emdashcms.com";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const ROTATED_PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI";
const ROTATED_MULTIKEY = "zDnaer52RTwabaBeMkKYYwZmEFqPabLW78cRK62iovMUQhFif";
const CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const LEGACY_URI = releaseUri("pre-rotation-bootstrap");
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };
let actionNumber = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("service identity", () => {
	it("publishes the label signing key and labeler service", async () => {
		const response = await SELF.fetch("https://test/.well-known/did.json");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(await response.json()).toEqual({
			"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
			id: LABELER_DID,
			verificationMethod: [
				{
					id: `${LABELER_DID}#atproto_label`,
					type: "Multikey",
					controller: LABELER_DID,
					publicKeyMultibase: MULTIKEY,
				},
			],
			service: [
				{
					id: `${LABELER_DID}#atproto_labeler`,
					type: "AtprotoLabeler",
					serviceEndpoint: LABELER_SERVICE_URL,
				},
			],
		});
	});

	it("publishes the canonical versioned moderation policy", async () => {
		const response = await SELF.fetch("https://test/.well-known/emdash-labeler-policy.json");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
		expect(await response.json()).toMatchObject({
			schemaVersion: 1,
			policyVersion: "2026-07-15.experimental.1",
			labelerDid: LABELER_DID,
			assessmentSchemaVersion: 1,
		});
		const etag = response.headers.get("etag")!;
		for (const ifNoneMatch of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
			const cached = await SELF.fetch("https://test/.well-known/emdash-labeler-policy.json", {
				headers: { "if-none-match": ifNoneMatch },
			});
			expect(cached.status).toBe(304);
		}
	});

	it("rejects identity, origin, and public-key configurations that cannot be published", async () => {
		const bindings = {
			LABELER_DID,
			LABELER_SERVICE_URL,
			LABEL_SIGNING_KEY_VERSION: "v1",
			LABEL_SIGNING_PUBLIC_KEY: MULTIKEY,
		};
		await expect(
			getLabelerIdentityConfig({ ...bindings, LABELER_DID: "did:plc:labeler" }),
		).rejects.toThrow("host-level did:web");
		await expect(
			getLabelerIdentityConfig({ ...bindings, LABELER_DID: `${LABELER_DID}:path` }),
		).rejects.toThrow("host-level did:web");
		await expect(
			getLabelerIdentityConfig({ ...bindings, LABELER_DID: "did:web:other.example" }),
		).rejects.toThrow("must match");
		await expect(
			getLabelerIdentityConfig({
				...bindings,
				LABELER_SERVICE_URL: `${LABELER_SERVICE_URL}:8443`,
			}),
		).rejects.toThrow("must match");
		await expect(
			getLabelerIdentityConfig({ ...bindings, LABEL_SIGNING_PUBLIC_KEY: "zDna1" }),
		).rejects.toThrow("canonical P-256 Multikey");
	});

	it("builds a versioned signer only when the secret matches the published key", async () => {
		let reads = 0;
		const runtime = await createRuntimeSigner(
			{
				labelerDid: LABELER_DID,
				serviceUrl: LABELER_SERVICE_URL,
				signingKeyVersion: "v1",
				signingPublicKeyMultibase: MULTIKEY,
			},
			{
				async get() {
					reads++;
					return PRIVATE_KEY;
				},
			},
		);
		expect(reads).toBe(1);
		expect(runtime).toMatchObject({
			keyVersion: "v1",
			publicKeyMultibase: MULTIKEY,
			signer: { issuerDid: LABELER_DID },
		});

		await expect(
			createRuntimeSigner(
				{
					labelerDid: LABELER_DID,
					serviceUrl: LABELER_SERVICE_URL,
					signingKeyVersion: "v1",
					signingPublicKeyMultibase: MULTIKEY,
				},
				{
					async get() {
						return ROTATED_PRIVATE_KEY;
					},
				},
			),
		).rejects.toThrow("does not match");
	});
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

async function rotatedSigner() {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: ROTATED_PRIVATE_KEY,
		resolveDid: async () => ({
			...document(),
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: LABELER_DID,
					publicKeyMultibase: ROTATED_MULTIKEY,
				},
			],
		}),
	});
}

function substitutingSigner(base: LabelSigner, uri: string): LabelSigner {
	return {
		issuerDid: base.issuerDid,
		sign(label) {
			return base.sign({ ...label, uri });
		},
	};
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
	return decodeLabelMessage(message);
}

function decodeLabelMessage(message: ArrayBuffer): { seq: number; label: Record<string, unknown> } {
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

async function nextLabels(
	ws: WebSocket,
	count: number,
): Promise<Array<{ seq: number; label: Record<string, unknown> }>> {
	return new Promise((resolve) => {
		const labels: Array<{ seq: number; label: Record<string, unknown> }> = [];
		const listener = (event: MessageEvent) => {
			labels.push(decodeLabelMessage(event.data as ArrayBuffer));
			if (labels.length !== count) return;
			ws.removeEventListener("message", listener);
			resolve(labels);
		};
		ws.addEventListener("message", listener);
	});
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

describe("signing-state bootstrap", () => {
	it("preserves legacy issuance and queries until rotation state is initialized", async () => {
		const issued = await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			action("pre-bootstrap issuance"),
			proposal(LEGACY_URI),
		);
		expect(issued.signingKeyVersion).toBe("legacy");
		const response = await SELF.fetch(
			`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(LEGACY_URI)}`,
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { labels: unknown[] }).labels).toHaveLength(1);

		await initializeSigningState(testEnv.DB, {
			issuerDid: LABELER_DID,
			keyVersion: config.signingKeyVersion,
			publicKeyMultibase: MULTIKEY,
		});
	});
});

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
		let signerReads = 0;
		const currentResponse = await queryLabels(
			testEnv.DB,
			new Request(
				`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(uri)}`,
			),
			async () => {
				signerReads++;
				throw new Error("signer should remain lazy");
			},
		);
		expect(currentResponse.status).toBe(200);
		expect(signerReads).toBe(0);
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

	it("preserves registry-record DID captures", async () => {
		await expect(
			issue(
				"at://did:example::leading-empty/com.emdashcms.experimental.package.profile/empty-leading-segment",
				"package-disputed",
			),
		).resolves.toBeDefined();
		await expect(
			issue(
				"at://did:example:doubled::segment/com.emdashcms.experimental.package.release/demo:1.0.0",
				"security-yanked",
			),
		).resolves.toBeDefined();
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				await signer(),
				action("collection captured as DID suffix"),
				proposal(
					"at://did:example:publisher:com.emdashcms.experimental.package.release/demo:1.0.0",
				),
			),
		).rejects.toThrow("release record");
	});

	it("rejects long invalid registry-record authorities without ambiguous matching", async () => {
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				await signer(),
				action("invalid long registry authority"),
				proposal(
					`at://did:example:${"%:".repeat(100_000)}!/com.emdashcms.experimental.package.release/demo`,
				),
			),
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

	it("rejects a valid-key signer that substitutes the authorized payload", async () => {
		await expect(
			issueManualLabel(
				testEnv.DB,
				config,
				substitutingSigner(await signer(), releaseUri("substituted")),
				action("payload substitution"),
				proposal(releaseUri("authorized")),
			),
		).rejects.toThrow("does not match the active public key");
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

describe("moderation reports", () => {
	it("rejects createReport as unsupported without persisting the report", async () => {
		const before = await testEnv.DB.batch([
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM issuance_actions"),
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM issued_labels"),
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM signing_events"),
		]);
		const response = await SELF.fetch("https://test/xrpc/com.atproto.moderation.createReport", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				reasonType: "com.atproto.moderation.defs#reasonOther",
				subject: { did: PUBLISHER_DID },
			}),
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			error: "NotSupported",
			message: "This labeler does not accept moderation reports",
		});
		const after = await testEnv.DB.batch([
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM issuance_actions"),
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM issued_labels"),
			testEnv.DB.prepare("SELECT COUNT(*) AS count FROM signing_events"),
		]);
		expect(after.map((result) => result.results)).toEqual(before.map((result) => result.results));
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
		const events = nextLabels(ws, 2);
		const published = issue(releaseUri("subscription-order-second"), undefined, false, true);
		const second = await published;
		expect((await events).map((event) => event.seq)).toEqual([first.sequence, second.sequence]);

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

describe("routine signing-key rotation", () => {
	it("pauses before sequence allocation, activates by CAS, and lazily re-signs history", async () => {
		const historicalAction = action("rotation history");
		const historicalProposal = proposal(releaseUri("rotation-history"));
		const historical = await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			historicalAction,
			historicalProposal,
		);
		const publishStarted = Promise.withResolvers<void>();
		const releasePublication = Promise.withResolvers<void>();
		const delayedIssue = issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			action("delayed pre-rotation publication"),
			proposal(releaseUri("rotation-delayed-publication")),
			undefined,
			{
				async publish() {
					publishStarted.resolve();
					await releasePublication.promise;
				},
			},
		);
		await publishStarted.promise;
		const sequenceBeforePause = await testEnv.DB.prepare(
			"SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels'",
		).first<{ next_sequence: number }>();
		const actionCountBeforePause = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM issuance_actions",
		).first<{ count: number }>();

		await expect(
			beginRoutineKeyRotation(testEnv.DB, {
				rotationId: "invalid-rotation",
				expectedActiveKeyVersion: "v1",
				nextKeyVersion: "invalid-key",
				nextPublicKeyMultibase: "zDna1",
			}),
		).rejects.toThrow("canonical P-256 Multikey");
		expect(await getSigningStatus(testEnv.DB)).toMatchObject({ phase: "active" });

		await beginRoutineKeyRotation(testEnv.DB, {
			rotationId: "rotation-v2",
			expectedActiveKeyVersion: "v1",
			nextKeyVersion: "v2",
			nextPublicKeyMultibase: ROTATED_MULTIKEY,
		});
		await expect(
			issueManualLabel(testEnv.DB, config, await signer(), historicalAction, historicalProposal),
		).resolves.toEqual(historical);
		await expect(issue(releaseUri("rotation-paused"))).rejects.toThrow("issuance is paused");
		expect(
			await testEnv.DB.prepare(
				"SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels'",
			).first<{ next_sequence: number }>(),
		).toEqual(sequenceBeforePause);
		expect(
			await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM issuance_actions").first<{
				count: number;
			}>(),
		).toEqual(actionCountBeforePause);

		const nextSigner = await rotatedSigner();
		await expect(
			activateRoutineKeyRotation(testEnv.DB, {
				rotationId: "rotation-v2",
				keyVersion: "v2",
				publicKeyMultibase: ROTATED_MULTIKEY,
				signer: await signer(),
			}),
		).rejects.toThrow("does not match the pending public key");
		await expect(
			activateRoutineKeyRotation(testEnv.DB, {
				rotationId: "rotation-v2",
				keyVersion: "v2",
				publicKeyMultibase: ROTATED_MULTIKEY,
				signer: nextSigner,
			}),
		).rejects.toThrow("lost its compare-and-swap");
		expect(await getSigningStatus(testEnv.DB)).toMatchObject({
			phase: "paused",
			activeKeyVersion: "v1",
		});
		releasePublication.resolve();
		await delayedIssue;
		await activateRoutineKeyRotation(testEnv.DB, {
			rotationId: "rotation-v2",
			keyVersion: "v2",
			publicKeyMultibase: ROTATED_MULTIKEY,
			signer: nextSigner,
		});
		await expect(
			issueManualLabel(
				testEnv.DB,
				{ ...config, signingKeyVersion: "v2" },
				nextSigner,
				historicalAction,
				historicalProposal,
			),
		).rejects.toThrow("must be refreshed before replay");
		await expect(issue(releaseUri("rotation-stale-worker"))).rejects.toThrow(
			"signing key version is stale",
		);
		await expect(
			issueManualLabel(
				testEnv.DB,
				{ ...config, signingKeyVersion: "v2" },
				await signer(),
				action("wrong key declared current"),
				proposal(releaseUri("rotation-wrong-key")),
			),
		).rejects.toThrow("does not match the active public key");
		const current = await issueManualLabel(
			testEnv.DB,
			{ ...config, signingKeyVersion: "v2" },
			nextSigner,
			action("post-rotation issue"),
			proposal(releaseUri("rotation-current")),
		);
		expect(current.signingKeyVersion).toBe("v2");
		const sequenceBeforeResigning = await testEnv.DB.prepare(
			"SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels'",
		).first<{ next_sequence: number }>();
		const liveSubscriber = await subscribe();
		const queryRequest = () =>
			new Request(
				`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(historical.label.uri)}`,
			);
		const signingRuntime = {
			signer: nextSigner,
			keyVersion: "v2",
			publicKeyMultibase: ROTATED_MULTIKEY,
		};
		const substitutedResign = await queryLabels(testEnv.DB, queryRequest(), {
			...signingRuntime,
			signer: substitutingSigner(nextSigner, releaseUri("resign-substituted")),
		});
		expect(substitutedResign.status).toBe(503);
		const invalidResign = await queryLabels(testEnv.DB, queryRequest(), {
			...signingRuntime,
			signer: await signer(),
		});
		expect(invalidResign.status).toBe(503);
		const [response, concurrentResponse] = await Promise.all([
			SELF.fetch(queryRequest()),
			queryLabels(testEnv.DB, queryRequest(), signingRuntime),
		]);
		expect(response.status).toBe(200);
		expect(concurrentResponse.status).toBe(200);
		const body = (await response.json()) as {
			labels: Array<{
				ver: 1;
				src: string;
				uri: string;
				val: string;
				cts: string;
				sig: { $bytes: string };
			}>;
		};
		const resigned = body.labels[0]!;
		expect(resigned.cts).toBe(historical.label.cts);
		await expect(
			verifyLabel({
				label: { ...resigned, sig: fromBase64(resigned.sig.$bytes) },
				resolveDid: async () => ({
					...document(),
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: LABELER_DID,
							publicKeyMultibase: ROTATED_MULTIKEY,
						},
					],
				}),
			}),
		).resolves.toMatchObject({ cts: historical.label.cts, uri: historical.label.uri });
		expect(await nextMessageWithin(liveSubscriber, 100)).toBeNull();
		liveSubscriber.close();
		const persisted = await testEnv.DB.prepare(
			"SELECT sequence, signing_key_version FROM issued_labels WHERE sequence = ?",
		)
			.bind(historical.sequence)
			.first<{ sequence: number; signing_key_version: string }>();
		expect(persisted).toEqual({ sequence: historical.sequence, signing_key_version: "v2" });
		expect(
			await testEnv.DB.prepare(
				"SELECT next_sequence FROM label_sequence WHERE name = 'issued_labels'",
			).first<{ next_sequence: number }>(),
		).toEqual(sequenceBeforeResigning);
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM label_signature_history WHERE label_sequence = ?",
			)
				.bind(historical.sequence)
				.first<{ count: number }>(),
		).toEqual({ count: 1 });
		let replayed: Awaited<ReturnType<typeof issueManualLabel>> | undefined;
		const replayPublisher: LabelPublisher = {
			async publish(label) {
				replayed = label;
			},
		};
		const replay = await issueManualLabel(
			testEnv.DB,
			{ ...config, signingKeyVersion: "v2" },
			nextSigner,
			historicalAction,
			historicalProposal,
			undefined,
			replayPublisher,
		);
		expect(replay.signingKeyVersion).toBe("v2");
		expect(replayed?.label.sig).toEqual(replay.label.sig);
		await queryLabels(testEnv.DB, queryRequest(), signingRuntime);
		expect(
			await testEnv.DB.prepare(
				"SELECT COUNT(*) AS count FROM label_signature_history WHERE label_sequence = ?",
			)
				.bind(historical.sequence)
				.first<{ count: number }>(),
		).toEqual({ count: 1 });

		expect(await getSigningStatus(testEnv.DB)).toMatchObject({
			phase: "active",
			activeKeyVersion: "v2",
			rotationId: "rotation-v2",
		});
		expect(await listSigningAlerts(testEnv.DB)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ISSUANCE_PAUSED" }),
				expect.objectContaining({ code: "STALE_SIGNING_KEY" }),
				expect.objectContaining({ code: "ROTATION_SIGNER_MISMATCH" }),
			]),
		);

		await expect(
			beginRoutineKeyRotation(testEnv.DB, {
				rotationId: "rotation-reuse-v1",
				expectedActiveKeyVersion: "v2",
				nextKeyVersion: "v1",
				nextPublicKeyMultibase: MULTIKEY,
			}),
		).rejects.toThrow("could not acquire the active key");
		expect(await getSigningStatus(testEnv.DB)).toMatchObject({
			phase: "active",
			activeKeyVersion: "v2",
		});

		await beginRoutineKeyRotation(testEnv.DB, {
			rotationId: "rotation-abort-v3",
			expectedActiveKeyVersion: "v2",
			nextKeyVersion: "v3",
			nextPublicKeyMultibase: ROTATED_MULTIKEY,
		});
		await abortRoutineKeyRotation(testEnv.DB, {
			rotationId: "rotation-abort-v3",
			expectedPendingKeyVersion: "v3",
		});
		expect(await getSigningStatus(testEnv.DB)).toMatchObject({
			phase: "active",
			activeKeyVersion: "v2",
		});

		const legacyRequest = () =>
			new Request(
				`https://test/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent(LEGACY_URI)}`,
			);
		expect((await queryLabels(testEnv.DB, legacyRequest())).status).toBe(503);
		expect((await queryLabels(testEnv.DB, legacyRequest())).status).toBe(503);
		expect(
			await testEnv.DB.prepare(
				`SELECT COUNT(*) AS count FROM signing_events
				 WHERE event_type = 'alert' AND code = 'RESIGN_CONFIGURATION_MISMATCH'`,
			).first<{ count: number }>(),
		).toEqual({ count: 1 });

		for (let index = 0; index < 4; index++) {
			const beforeRace = await getSigningStatus(testEnv.DB);
			const keyVersion = `race-v${index}`;
			const rotationId = `rotation-race-${index}`;
			await beginRoutineKeyRotation(testEnv.DB, {
				rotationId,
				expectedActiveKeyVersion: beforeRace.activeKeyVersion,
				nextKeyVersion: keyVersion,
				nextPublicKeyMultibase: ROTATED_MULTIKEY,
			});
			const activation = () =>
				activateRoutineKeyRotation(testEnv.DB, {
					rotationId,
					keyVersion,
					publicKeyMultibase: ROTATED_MULTIKEY,
					signer: nextSigner,
				});
			const abort = () =>
				abortRoutineKeyRotation(testEnv.DB, {
					rotationId,
					expectedPendingKeyVersion: keyVersion,
				});
			const outcomes = await Promise.allSettled(
				index % 2 === 0 ? [activation(), abort()] : [abort(), activation()],
			);
			expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
			const afterRace = await getSigningStatus(testEnv.DB);
			const activeRegistryKey = await testEnv.DB.prepare(
				"SELECT key_version FROM signing_key_versions WHERE status = 'active'",
			).first<{ key_version: string }>();
			expect(activeRegistryKey?.key_version).toBe(afterRace.activeKeyVersion);
			const transitions = await testEnv.DB.prepare(
				`SELECT COUNT(*) AS count FROM signing_events
				 WHERE rotation_id = ? AND code IN ('ROTATION_ACTIVATED', 'ROTATION_ABORTED')`,
			)
				.bind(rotationId)
				.first<{ count: number }>();
			expect(transitions?.count).toBe(1);
		}
	});
});

function fromBase64(value: string): Uint8Array {
	const decoded = atob(value);
	return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
