import { encode } from "@atcute/cbor";
import { P256PrivateKeyExportable, P256PublicKey, parsePublicMultikey } from "@atcute/crypto";
import { toBase64Url } from "@atcute/multibase";
import {
	createListingLabelSigner,
	verifyListingLabel,
	type LabelDidDocument,
	type ListingLabelSigner,
	type SignedListingLabel,
} from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { acceptListingLabels, readLabelCursor } from "../src/label-ingestion.js";
import { LabelIngestor } from "../src/label-ingestor.js";
import {
	markLabelSourceFailure,
	markLabelSourceHealthy,
	REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS,
	readLabelSourceActivationState,
	stageLabelSourceReplay,
} from "../src/label-source-health.js";
import {
	acknowledgeLabelSourceStop,
	activateLabelSourceAfterReplay,
	readLabelSourceTrust,
	reconcileLabelSources,
	type LabelSourcePolicy,
} from "../src/label-source-policy.js";
import { decodeLabelStreamFrame, RealLabelQueryClient } from "../src/label-stream-client.js";
import type {
	LabelQueryClient,
	LabelStreamClient,
	LabelStreamEvent,
	LabelStreamHandle,
} from "../src/label-stream-client.js";
import { LabelerResolver } from "../src/labeler-resolver.js";
import { readProjectionWork } from "../src/projection-work.js";
import { readWinningLabelCandidates } from "../src/public-projection.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const SOURCE = "did:web:labels.example";
const URI = "at://did:plc:publisher00000000000000/com.emdashcms.experimental.package.profile/demo";
const CID_A = "bafkreibm6jg3ux5qum7qzbct7fpb5czfcyq3rzrwa7wmx4zzgfalkqsocy";
const CID_B = "bafkreifn2ui3tr5zgs7t7hvyrrh37mx2wppfb26bfqkwzi7h2lxyjcvf5a";
const NOW = "2026-08-24T12:00:00.000Z";

interface SigningFixture {
	signer: ListingLabelSigner;
	document: LabelDidDocument;
	publicKey: P256PublicKey;
}

function resolvedIdentity(publicKey: P256PublicKey) {
	return {
		endpoint: "https://labels.example",
		publicKey,
		signingKeyId: `${SOURCE}#atproto_label`,
		resolvedAtEpochMs: 0,
		expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
	};
}

async function signingFixture(): Promise<SigningFixture> {
	const keypair = await P256PrivateKeyExportable.createKeypair();
	const multikey = await keypair.exportPublicKey("multikey");
	const parsed = parsePublicMultikey(multikey);
	if (parsed.type !== "p256") throw new Error("test key was not P-256");
	const document: LabelDidDocument = {
		id: SOURCE,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: SOURCE,
				publicKeyMultibase: multikey,
			},
		],
	};
	return {
		signer: await createListingLabelSigner({
			issuerDid: SOURCE,
			privateKey: toBase64Url(await keypair.exportPrivateKey("raw")),
			resolveDid: async () => document,
		}),
		document,
		publicKey: await P256PublicKey.importRaw(parsed.publicKeyBytes),
	};
}

function sourcePolicy(active: boolean): LabelSourcePolicy {
	return {
		requiredPositiveSources: active ? [SOURCE] : [],
		acceptedStateSources: [],
		redactionSources: active ? [SOURCE] : [],
		acceptedSources: new Set(active ? [SOURCE] : []),
		policyVersion: active ? "test-v1" : "test-v2",
	};
}

async function accept(
	signed: SignedListingLabel,
	document: LabelDidDocument,
	sequence: number,
	trusted = true,
): Promise<void> {
	const verified = await verifyListingLabel({ label: signed, resolveDid: async () => document });
	await acceptListingLabels({
		db: testEnv.DB,
		source: SOURCE,
		labels: [{ signed, verified }],
		sourceSequence: sequence,
		cursor: sequence,
		receivedAt: new Date(NOW),
		trusted,
	});
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	for (const table of [
		"listing_label_stream_coordinates",
		"listing_labels",
		"listing_label_state_expiry",
		"label_state",
		"labeler_signing_keys",
		"labellers",
		"ingest_state",
	]) {
		await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
	}
	await reconcileLabelSources(testEnv.DB, sourcePolicy(true));
	await activateLabelSourceAfterReplay(testEnv.DB, SOURCE, "test-v1", 1, new Date(NOW));
	await testEnv.DB.prepare(
		`UPDATE listing_projection_work
		 SET scheduled_epoch = dirty_epoch, acknowledged_epoch = dirty_epoch WHERE id = 1`,
	).run();
});

describe("signed label persistence", () => {
	it("pages only the winning-time label candidates while preserving distinct ties", async () => {
		for (const [digest, cid, cts, epoch] of [
			["old", CID_A, "2026-08-24T11:00:00.000Z", 1_776_594_000],
			["tie-a", CID_A, NOW, 1_776_597_600],
			["tie-b", CID_B, NOW, 1_776_597_600],
		] as const) {
			await testEnv.DB.prepare(
				`INSERT INTO listing_labels
				   (digest, state_digest, src, uri, cid, val, neg, cts, cts_epoch,
				    cts_fraction, exp, exp_epoch, sig, ver, received_at)
				 VALUES (?, ?, ?, ?, ?, 'listing-review', 0, ?, ?, ?, NULL, NULL, ?, 1, ?)`,
			)
				.bind(
					digest,
					digest,
					SOURCE,
					URI,
					cid,
					cts,
					epoch,
					"0".repeat(32),
					new Uint8Array([1]),
					NOW,
				)
				.run();
		}
		const candidates = await readWinningLabelCandidates(testEnv.DB);
		expect(
			candidates
				.map((candidate) => candidate.cid)
				.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
		).toEqual([CID_A, CID_B].toSorted((a, b) => a.localeCompare(b)));
	});

	it("stores verified history and state before advancing the source cursor", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(signed, fixture.document, 1);

		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
		const history = await testEnv.DB.prepare(
			`SELECT src, uri, cid, val FROM listing_labels`,
		).first();
		expect(history).toMatchObject({ src: SOURCE, uri: URI, cid: CID_A, val: "listing-passed" });
		const state = await testEnv.DB.prepare(
			`SELECT cid, neg, collision, trusted FROM label_state`,
		).first();
		expect(state).toMatchObject({ cid: CID_A, neg: 0, collision: 0, trusted: 1 });
	});

	it("is idempotent under full replay and rejects a stream coordinate collision", async () => {
		const fixture = await signingFixture();
		const first = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(first, fixture.document, 1);
		await accept(first, fixture.document, 1);
		expect(
			(
				await testEnv.DB.prepare(`SELECT COUNT(*) AS count FROM listing_labels`).first<{
					count: number;
				}>()
			)?.count,
		).toBe(1);

		const conflicting = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_B,
			val: "listing-passed",
			cts: "2026-08-24T12:00:01.000Z",
		});
		await expect(accept(conflicting, fixture.document, 1)).rejects.toThrow(/coordinate collision/);
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
	});

	it("keeps newer negation state when older delivery arrives later", async () => {
		const fixture = await signingFixture();
		const newer = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			neg: true,
			cts: "2026-08-24T12:00:02.000Z",
		});
		const older = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(newer, fixture.document, 2);
		await accept(older, fixture.document, 1);
		const state = await testEnv.DB.prepare(`SELECT neg, cts FROM label_state`).first();
		expect(state).toMatchObject({ neg: 1, cts: "2026-08-24T12:00:02.000Z" });
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(2);
	});

	it("fails closed on different events at the same instant", async () => {
		const fixture = await signingFixture();
		const first = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		const second = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_B,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(first, fixture.document, 1);
		await accept(second, fixture.document, 2);
		const state = await testEnv.DB.prepare(`SELECT collision FROM label_state`).first<{
			collision: number;
		}>();
		expect(state?.collision).toBe(1);
	});

	it("demotes current state when policy removes its source", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(signed, fixture.document, 1);
		await reconcileLabelSources(testEnv.DB, sourcePolicy(false));
		const state = await testEnv.DB.prepare(`SELECT trusted FROM label_state`).first<{
			trusted: number;
		}>();
		expect(state?.trusted).toBe(0);
	});

	it("keeps a re-added source and its caught-up state untrusted until replay promotion", async () => {
		const fixture = await signingFixture();
		const pass = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(pass, fixture.document, 1);
		await reconcileLabelSources(testEnv.DB, sourcePolicy(false));
		await acknowledgeLabelSourceStop(testEnv.DB, SOURCE);

		await reconcileLabelSources(testEnv.DB, sourcePolicy(true));
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(false);
		expect(
			await testEnv.DB.prepare("SELECT trusted FROM label_state WHERE src = ?")
				.bind(SOURCE)
				.first(),
		).toMatchObject({ trusted: 0 });

		const revoke = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			neg: true,
			cts: "2026-08-24T12:00:01.000Z",
		});
		await accept(revoke, fixture.document, 2, false);
		expect(
			await testEnv.DB.prepare("SELECT neg, trusted FROM label_state WHERE src = ?")
				.bind(SOURCE)
				.first(),
		).toMatchObject({ neg: 1, trusted: 0 });

		await activateLabelSourceAfterReplay(testEnv.DB, SOURCE, "test-v1", 2, new Date(NOW));
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(true);
		expect(
			await testEnv.DB.prepare("SELECT neg, trusted FROM label_state WHERE src = ?")
				.bind(SOURCE)
				.first(),
		).toMatchObject({ neg: 1, trusted: 1 });
	});

	it("persists failure state and demotes only at the deterministic health boundary", async () => {
		await markLabelSourceHealthy(testEnv.DB, SOURCE, new Date(NOW));
		const firstFailure = new Date(NOW);
		expect(await markLabelSourceFailure(testEnv.DB, SOURCE, firstFailure)).toBe(false);
		expect(
			await testEnv.DB.prepare(
				`SELECT health_failure_count, health_failure_started_at, trusted
				 FROM labellers WHERE did = ?`,
			)
				.bind(SOURCE)
				.first(),
		).toEqual({ health_failure_count: 1, health_failure_started_at: NOW, trusted: 1 });

		const beforeBoundary = new Date(
			firstFailure.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS - 1,
		);
		expect(await markLabelSourceFailure(testEnv.DB, SOURCE, beforeBoundary)).toBe(false);
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(true);

		const boundary = new Date(firstFailure.getTime() + REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS);
		expect(await markLabelSourceFailure(testEnv.DB, SOURCE, boundary)).toBe(true);
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(false);
		await markLabelSourceHealthy(testEnv.DB, SOURCE, new Date(boundary.getTime() + 1));
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(false);

		const fixture = await signingFixture();
		const latePass = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_B,
			val: "listing-passed",
			cts: new Date(boundary.getTime() + 2).toISOString(),
		});
		await accept(latePass, fixture.document, 1, true);
		expect(
			await testEnv.DB.prepare("SELECT trusted FROM label_state WHERE src = ? AND cid = ?")
				.bind(SOURCE, CID_B)
				.first(),
		).toEqual({ trusted: 0 });
	});

	it("restarts a staged replay from cursor zero and clears pending state only after catch-up", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(signed, fixture.document, 9);
		await markLabelSourceHealthy(testEnv.DB, SOURCE, new Date(NOW));
		await stageLabelSourceReplay(testEnv.DB, SOURCE, new Date(NOW));
		let queryCursor = -1;
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: new ArrayStream([]),
			query: {
				query: async (_endpoint, _source, cursor) => {
					queryCursor = cursor;
					return { labels: [signed] };
				},
			},
			onAccepted: async () => {},
			sourceTrust: {
				read: () => readLabelSourceActivationState(testEnv.DB, SOURCE),
				activate: async (generation, at) => {
					await activateLabelSourceAfterReplay(testEnv.DB, SOURCE, "test-v1", generation, at);
				},
				markHealthy: (at) => markLabelSourceHealthy(testEnv.DB, SOURCE, at),
				markFailure: (at) => markLabelSourceFailure(testEnv.DB, SOURCE, at),
			},
			now: () => Date.parse(NOW),
			sleep: async () => ingestor.stop(),
		});

		await ingestor.run();
		expect(queryCursor).toBe(0);
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(true);
		expect(
			await testEnv.DB.prepare(
				"SELECT replay_pending, health_failure_count FROM labellers WHERE did = ?",
			)
				.bind(SOURCE)
				.first(),
		).toEqual({ replay_pending: 0, health_failure_count: 0 });
	});

	it("rejects stale replay-generation activation after a newer replay stage wins", async () => {
		await stageLabelSourceReplay(testEnv.DB, SOURCE, new Date(NOW));
		const first = await readLabelSourceActivationState(testEnv.DB, SOURCE);
		expect(first).toEqual({ trusted: false, replayGeneration: 2 });
		await stageLabelSourceReplay(testEnv.DB, SOURCE, new Date(NOW));
		const second = await readLabelSourceActivationState(testEnv.DB, SOURCE);
		expect(second).toEqual({ trusted: false, replayGeneration: 3 });

		expect(
			await activateLabelSourceAfterReplay(
				testEnv.DB,
				SOURCE,
				"test-v1",
				first.replayGeneration,
				new Date(NOW),
			),
		).toBe(false);
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(false);
		expect(
			await activateLabelSourceAfterReplay(
				testEnv.DB,
				SOURCE,
				"test-v1",
				second.replayGeneration,
				new Date(NOW),
			),
		).toBe(true);
	});

	it("cannot re-trust state with a late write after policy removes its source", async () => {
		const fixture = await signingFixture();
		const first = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		await accept(first, fixture.document, 1);
		const removal = await reconcileLabelSources(testEnv.DB, sourcePolicy(false));
		expect(removal.sourcesRequiringStop).toEqual([SOURCE]);
		expect(
			(await reconcileLabelSources(testEnv.DB, sourcePolicy(false))).sourcesRequiringStop,
		).toEqual([SOURCE]);
		expect(await acknowledgeLabelSourceStop(testEnv.DB, SOURCE)).toBe(true);
		expect(
			(await reconcileLabelSources(testEnv.DB, sourcePolicy(false))).sourcesRequiringStop,
		).toEqual([]);

		const late = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_B,
			val: "listing-passed",
			cts: "2026-08-24T12:00:01.000Z",
		});
		await expect(accept(late, fixture.document, 2)).rejects.toThrow(/source is inactive/);
		const state = await testEnv.DB.prepare(`SELECT cid, trusted FROM label_state`).first();
		expect(state).toMatchObject({ cid: CID_A, trusted: 0 });
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
	});

	it("does not treat two valid signatures of one semantic event as a state collision", async () => {
		const fixture = await signingFixture();
		const event = {
			ver: 1 as const,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		};
		await accept(await fixture.signer.sign(event), fixture.document, 1);
		await accept(await fixture.signer.sign(event), fixture.document, 2);
		const state = await testEnv.DB.prepare(`SELECT collision FROM label_state`).first<{
			collision: number;
		}>();
		expect(state?.collision).toBe(0);
	});
});

class ArrayStream implements LabelStreamClient {
	constructor(private readonly events: readonly LabelStreamEvent[]) {}
	subscribe(): LabelStreamHandle {
		const events = this.events;
		return {
			close() {},
			async *[Symbol.asyncIterator]() {
				for (const event of events) yield event;
			},
		};
	}
}

const emptyQuery: LabelQueryClient = {
	query: async () => ({ labels: [] }),
};

describe("subscription verification", () => {
	it("renews persisted freshness after each successful empty catch-up", async () => {
		const fixture = await signingFixture();
		let now = 0;
		let queries = 0;
		const healthyAt: number[] = [];
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: new ArrayStream([]),
			query: {
				query: async () => {
					queries++;
					return { labels: [] };
				},
			},
			onAccepted: async () => {},
			sourceTrust: {
				read: async () => ({ trusted: true, replayGeneration: 0 }),
				activate: async () => {
					throw new Error("trusted source must not reactivate");
				},
				markHealthy: async (at) => {
					healthyAt.push(at.getTime());
				},
				markFailure: async () => false,
			},
			now: () => now,
			sleep: async () => {
				if (queries >= 2) ingestor.stop();
				else now += 5 * 60 * 1_000;
			},
		});

		await ingestor.run();
		expect(healthyAt).toEqual([0, 5 * 60 * 1_000]);
		expect(REQUIRED_LABEL_SOURCE_HEALTH_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1_000);
	});

	it("replays a prior retained signing key while a re-added source is still untrusted", async () => {
		const oldFixture = await signingFixture();
		const rotated = await signingFixture();
		let now = new Date("2026-08-24T12:00:00.000Z");
		let verificationMethod = oldFixture.document.verificationMethod;
		const resolver = new LabelerResolver(
			testEnv.DB,
			{
				resolve: async () => ({
					id: SOURCE,
					service: [
						{
							id: "#atproto_labeler",
							type: "AtprotoLabeler",
							serviceEndpoint: "https://labels.example",
						},
					],
					verificationMethod,
				}),
			},
			300_000,
			() => now,
		);
		await resolver.resolveFresh(SOURCE);
		now = new Date("2026-08-24T12:00:05.000Z");
		verificationMethod = rotated.document.verificationMethod;
		await resolver.resolveFresh(SOURCE);
		await reconcileLabelSources(testEnv.DB, sourcePolicy(false));
		await acknowledgeLabelSourceStop(testEnv.DB, SOURCE);
		await reconcileLabelSources(testEnv.DB, sourcePolicy(true));
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(false);

		const historical = await oldFixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver,
			verificationKeys: (source) => resolver.verificationKeys(source),
			stream: new ArrayStream([]),
			query: { query: async () => ({ labels: [historical] }) },
			onAccepted: async () => {},
			sourceTrust: {
				read: () => readLabelSourceActivationState(testEnv.DB, SOURCE),
				activate: async (generation, at) => {
					await activateLabelSourceAfterReplay(testEnv.DB, SOURCE, "test-v1", generation, at);
				},
				markHealthy: (at) => markLabelSourceHealthy(testEnv.DB, SOURCE, at),
				markFailure: (at) => markLabelSourceFailure(testEnv.DB, SOURCE, at),
			},
			now: () => now.getTime(),
			sleep: async () => ingestor.stop(),
		});

		await ingestor.run();
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(true);
		expect(
			await testEnv.DB.prepare("SELECT trusted FROM label_state WHERE src = ?")
				.bind(SOURCE)
				.first(),
		).toMatchObject({ trusted: 1 });
	});

	it("promotes a pending source only after identity resolution and authoritative query catch-up", async () => {
		const fixture = await signingFixture();
		await reconcileLabelSources(testEnv.DB, sourcePolicy(false));
		await acknowledgeLabelSourceStop(testEnv.DB, SOURCE);
		await reconcileLabelSources(testEnv.DB, sourcePolicy(true));
		const order: string[] = [];
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => {
					order.push("resolve");
					return resolvedIdentity(fixture.publicKey);
				},
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: new ArrayStream([]),
			query: {
				query: async () => {
					order.push("query");
					return { labels: [] };
				},
			},
			onAccepted: async () => {},
			sourceTrust: {
				read: () => readLabelSourceActivationState(testEnv.DB, SOURCE),
				activate: async (generation, at) => {
					order.push("activate");
					await activateLabelSourceAfterReplay(testEnv.DB, SOURCE, "test-v1", generation, at);
				},
				markHealthy: (at) => markLabelSourceHealthy(testEnv.DB, SOURCE, at),
				markFailure: (at) => markLabelSourceFailure(testEnv.DB, SOURCE, at),
			},
			sleep: async () => ingestor.stop(),
		});

		await ingestor.run();
		expect(order.slice(0, 3)).toEqual(["resolve", "query", "activate"]);
		expect(await readLabelSourceTrust(testEnv.DB, SOURCE)).toBe(true);
	});

	it("verifies one replay page across an observed same-DID key rotation", async () => {
		const oldFixture = await signingFixture();
		const rotated = await signingFixture();
		const oldLabel = await oldFixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-pending",
			cts: NOW,
		});
		const newLabel = await rotated.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: "2026-08-24T12:00:01.000Z",
		});
		let fresh = 0;
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(oldFixture.publicKey),
				resolveFresh: async () => {
					fresh++;
					return resolvedIdentity(rotated.publicKey);
				},
			},
			verificationKeys: async () =>
				fresh === 0
					? [{ publicKey: oldFixture.publicKey }]
					: [
							{
								publicKey: oldFixture.publicKey,
								validUntilEpochMs: Date.parse("2026-08-24T12:00:02.000Z"),
							},
							{ publicKey: rotated.publicKey },
						],
			stream: new ArrayStream([
				{ seq: 1, labels: [oldLabel] },
				{ seq: 2, labels: [newLabel] },
			]),
			query: { query: async () => ({ labels: [oldLabel, newLabel] }) },
			onAccepted: async () => {},
			sleep: async () => ingestor.stop(),
		});
		await ingestor.run();
		expect(fresh).toBe(1);
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(2);
		expect(
			(
				await testEnv.DB.prepare(`SELECT COUNT(*) AS count FROM listing_labels`).first<{
					count: number;
				}>()
			)?.count,
		).toBe(2);
	});

	it("refreshes the DID service and key before the cached identity age limit", async () => {
		const fixture = await signingFixture();
		const rotated = await signingFixture();
		let now = new Date("2026-08-24T12:00:00.000Z");
		let endpoint = "https://labels-a.example";
		let verificationMethod = fixture.document.verificationMethod;
		let resolutions = 0;
		const resolver = new LabelerResolver(
			testEnv.DB,
			{
				resolve: async () => {
					resolutions++;
					return {
						id: SOURCE,
						service: [
							{
								id: "#atproto_labeler",
								type: "AtprotoLabeler",
								serviceEndpoint: endpoint,
							},
						],
						verificationMethod,
					};
				},
			},
			300_000,
			() => now,
		);
		const first = await resolver.resolve(SOURCE);
		expect(first.endpoint).toBe("https://labels-a.example");
		expect(first.expiresAtEpochMs).toBe(now.getTime() + 300_000);

		now = new Date(now.getTime() + 299_999);
		await resolver.resolve(SOURCE);
		expect(resolutions).toBe(1);
		endpoint = "https://labels-b.example";
		verificationMethod = rotated.document.verificationMethod;
		now = new Date(now.getTime() + 1);
		const refreshed = await resolver.resolve(SOURCE);
		expect(refreshed.endpoint).toBe("https://labels-b.example");
		expect(resolutions).toBe(2);
		expect(await resolver.verificationKeys(SOURCE)).toHaveLength(2);
	});

	it("refreshes the DID key once for rotation and accepts the verified frame", async () => {
		const oldFixture = await signingFixture();
		const rotated = await signingFixture();
		const signed = await rotated.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		let freshResolutions = 0;
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(oldFixture.publicKey),
				resolveFresh: async () => {
					freshResolutions++;
					return resolvedIdentity(rotated.publicKey);
				},
			},
			stream: new ArrayStream([{ seq: 1, labels: [signed] }]),
			query: emptyQuery,
			onAccepted: async () => {},
			sleep: async () => ingestor.stop(),
		});
		await ingestor.run();
		expect(freshResolutions).toBe(1);
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
	});

	it("does not persist a forged label after the one permitted key refresh", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		const forged = { ...signed, sig: Uint8Array.from(signed.sig, (byte, index) => byte ^ +!index) };
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: new ArrayStream([{ seq: 1, labels: [forged] }]),
			query: emptyQuery,
			onAccepted: async () => {},
			sleep: async () => ingestor.stop(),
		});
		await ingestor.run();
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(0);
		expect(
			(
				await testEnv.DB.prepare(`SELECT COUNT(*) AS count FROM listing_labels`).first<{
					count: number;
				}>()
			)?.count,
		).toBe(0);
	});

	it("rejects a frame arriving after the resolved identity expires", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		let now = 0;
		const expiringStream: LabelStreamClient = {
			subscribe: () => ({
				close() {},
				async *[Symbol.asyncIterator]() {
					now = 5;
					yield { seq: 1, labels: [signed] };
				},
			}),
		};
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => ({ ...resolvedIdentity(fixture.publicKey), expiresAtEpochMs: 5 }),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: expiringStream,
			query: emptyQuery,
			onAccepted: async () => {},
			now: () => now,
			scheduleExpiry: () => () => {},
			sleep: async () => ingestor.stop(),
		});
		await ingestor.run();
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(0);
	});

	it("marks one state change while the final query page catches up through stream replay", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		let dirty = 0;
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: new ArrayStream([{ seq: 1, labels: [signed] }]),
			query: { query: async () => ({ labels: [signed] }) },
			onAccepted: async () => {
				dirty++;
			},
			sleep: async () => ingestor.stop(),
		});
		await ingestor.run();
		expect(dirty).toBe(1);
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
	});

	it("closes the active subscription when stopped", async () => {
		const fixture = await signingFixture();
		let close!: () => void;
		let closed = 0;
		const closedSignal = new Promise<void>((resolve) => {
			close = resolve;
		});
		const stream: LabelStreamClient = {
			subscribe: () => ({
				close() {
					closed++;
					close();
				},
				[Symbol.asyncIterator]() {
					return {
						async next(): Promise<IteratorResult<LabelStreamEvent>> {
							await closedSignal;
							return { value: undefined, done: true };
						},
					};
				},
			}),
		};
		const ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream,
			query: emptyQuery,
			onAccepted: async () => {},
		});
		const running = ingestor.run();
		await new Promise((resolve) => setTimeout(resolve, 0));
		ingestor.stop();
		await running;
		expect(closed).toBeGreaterThan(0);
	});

	it("interrupts retry backoff so a stop fence can await the old writer", async () => {
		const fixture = await signingFixture();
		let markSubscribed!: () => void;
		const subscribed = new Promise<void>((resolve) => {
			markSubscribed = resolve;
		});
		const ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream: {
				subscribe: () => {
					markSubscribed();
					return new ArrayStream([]).subscribe();
				},
			},
			query: emptyQuery,
			onAccepted: async () => {},
			sleep: async () => new Promise<void>(() => {}),
		});
		const running = ingestor.run();
		await subscribed;
		ingestor.stop();
		const result = await Promise.race([
			running.then(() => "stopped"),
			new Promise<string>((resolve) => setTimeout(resolve, 50, "timeout")),
		]);
		expect(result).toBe("stopped");
	});

	it("retries a lost dirty notification after the label and cursor commit", async () => {
		const fixture = await signingFixture();
		const signed = await fixture.signer.sign({
			ver: 1,
			uri: URI,
			cid: CID_A,
			val: "listing-passed",
			cts: NOW,
		});
		let subscriptions = 0;
		const stream: LabelStreamClient = {
			subscribe: () =>
				new ArrayStream(subscriptions++ === 0 ? [{ seq: 1, labels: [signed] }] : []).subscribe(),
		};
		let notifications = 0;
		let ingestor: LabelIngestor;
		ingestor = new LabelIngestor({
			did: SOURCE,
			db: testEnv.DB,
			resolver: {
				resolve: async () => resolvedIdentity(fixture.publicKey),
				resolveFresh: async () => resolvedIdentity(fixture.publicKey),
			},
			stream,
			query: emptyQuery,
			onAccepted: async () => {
				notifications++;
				if (notifications === 1) throw new Error("notification unavailable");
			},
			sleep: async () => {
				if (notifications >= 2) ingestor.stop();
			},
		});
		await ingestor.run();
		expect(notifications).toBe(2);
		expect(await readLabelCursor(testEnv.DB, SOURCE)).toBe(1);
		expect((await readProjectionWork(testEnv.DB)).rebuildPending).toBe(true);
	});
});

describe("subscription frame bounds", () => {
	it("rejects oversized frames before CBOR decode", () => {
		expect(() => decodeLabelStreamFrame(new Uint8Array(1024 * 1024 + 1))).toThrow(/frame exceeds/);
	});

	it("rejects trailing CBOR values", () => {
		const header = encode({ op: 1, t: "#labels" });
		const payload = encode({ seq: 1, labels: [{}] });
		const trailing = encode(null);
		const bytes = new Uint8Array(header.length + payload.length + trailing.length);
		bytes.set(header);
		bytes.set(payload, header.length);
		bytes.set(trailing, header.length + payload.length);
		expect(() => decodeLabelStreamFrame(bytes)).toThrow(/payload is invalid CBOR/);
	});
});

describe("query replay bounds", () => {
	it("decodes base64url signatures returned by queryLabels", async () => {
		const signature = new Uint8Array(64).fill(255);
		const client = new RealLabelQueryClient(async () =>
			Response.json({
				labels: [
					{
						ver: 1,
						src: SOURCE,
						uri: URI,
						cid: CID_A,
						val: "listing-passed",
						cts: NOW,
						sig: { $bytes: toBase64Url(signature) },
					},
				],
				cursor: "1",
			}),
		);

		await expect(client.query("https://labels.example", SOURCE, 0)).resolves.toEqual({
			labels: [
				{
					ver: 1,
					src: SOURCE,
					uri: URI,
					cid: CID_A,
					val: "listing-passed",
					cts: NOW,
					sig: signature,
				},
			],
			nextCursor: 1,
		});
	});

	it("rejects more than the requested 250 labels before parsing them", async () => {
		const client = new RealLabelQueryClient(async () =>
			Response.json({ labels: Array.from({ length: 251 }, () => ({})) }),
		);
		await expect(client.query("https://labels.example", SOURCE, 0)).rejects.toThrow(
			/more than 250/,
		);
	});

	it("rejects a response body beyond the configured byte bound", async () => {
		const client = new RealLabelQueryClient(
			async () => new Response(JSON.stringify({ labels: [], padding: "x".repeat(64) })),
			1_000,
			32,
		);
		await expect(client.query("https://labels.example", SOURCE, 0)).rejects.toThrow(/byte limit/);
	});

	it("aborts a query that exceeds its timeout", async () => {
		const client = new RealLabelQueryClient(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
			1,
		);
		await expect(client.query("https://labels.example", SOURCE, 0)).rejects.toThrow(/aborted/);
	});
});
