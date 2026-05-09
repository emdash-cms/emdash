/**
 * Round-trip test: prove the test infrastructure produces records that pass
 * a real verifier.
 *
 * This is the load-bearing test for the whole mock stack. If a record signed
 * and stored in a FakeRepo, fetched via MockPds.sync.getRecord as a CAR, and
 * fed into @atcute/repo's `verifyRecord` doesn't pass, the mocks aren't
 * exercising the code path the aggregator will run in production. Every
 * other consumer of these mocks builds on this guarantee.
 */

import { P256PublicKey } from "@atcute/crypto";
import { verifyRecord } from "@atcute/repo";
import { describe, expect, it } from "vitest";

import {
	PROFILE_NSID,
	RELEASE_NSID,
	createFakePublisherFixture,
	parseDidKey,
} from "../src/index.js";

describe("FakeRepo + MockPds → @atcute/repo verifyRecord", () => {
	it("verifies a profile record fetched as a CAR", async () => {
		const fixture = createFakePublisherFixture();
		const alice = await fixture.createPublisher({
			did: "did:plc:alice00000000000000000",
			handle: "alice.test",
		});
		await alice.publishProfile({
			slug: "test-plugin",
			license: "MIT",
			authors: [{ name: "Alice" }],
			securityEmail: "security@alice.test",
		});

		const car = await alice.repo.getRecordCar(PROFILE_NSID, "test-plugin");
		expect(car.length).toBeGreaterThan(0);

		const publicKey = await loadPublicKey(alice.repo.didKey());

		const verified = await verifyRecord({
			did: alice.did,
			collection: PROFILE_NSID,
			rkey: "test-plugin",
			publicKey,
			carBytes: car,
		});

		expect(verified.cid).toBeTruthy();
		const record = verified.record as Record<string, unknown>;
		expect(record.slug).toBe("test-plugin");
		expect(record.license).toBe("MIT");
	});

	it("verifies a release record after the profile was already published", async () => {
		const fixture = createFakePublisherFixture();
		const bob = await fixture.createPublisher({
			did: "did:plc:bob000000000000000000000",
			handle: "bob.test",
		});
		await bob.publishProfile({
			slug: "rel-plugin",
			license: "MIT",
			securityEmail: "security@bob.test",
		});
		await bob.publishRelease({
			slug: "rel-plugin",
			version: "1.0.0",
			checksum: "bciqtestchecksum",
			url: "https://example.test/rel-plugin-1.0.0.tar.gz",
		});

		const car = await bob.repo.getRecordCar(RELEASE_NSID, "rel-plugin:1.0.0");
		const publicKey = await loadPublicKey(bob.repo.didKey());

		const verified = await verifyRecord({
			did: bob.did,
			collection: RELEASE_NSID,
			rkey: "rel-plugin:1.0.0",
			publicKey,
			carBytes: car,
		});

		const record = verified.record as Record<string, unknown>;
		expect(record.package).toBe("rel-plugin");
		expect(record.version).toBe("1.0.0");
	});

	it("rejects a CAR signed by a different keypair", async () => {
		const fixture = createFakePublisherFixture();
		const carol = await fixture.createPublisher({ did: "did:plc:carol00000000000000000000" });
		const dave = await fixture.createPublisher({ did: "did:plc:dave000000000000000000000" });

		await carol.publishProfile({ slug: "p", license: "MIT", securityEmail: "x@y.test" });
		const car = await carol.repo.getRecordCar(PROFILE_NSID, "p");

		// Use dave's public key against carol's CAR. Verification must reject.
		const wrongKey = await loadPublicKey(dave.repo.didKey());
		await expect(
			verifyRecord({
				did: carol.did,
				collection: PROFILE_NSID,
				rkey: "p",
				publicKey: wrongKey,
				carBytes: car,
			}),
		).rejects.toThrow();
	});
});

describe("MockPds XRPC dispatch", () => {
	it("returns the CAR bytes via /xrpc/com.atproto.sync.getRecord", async () => {
		const fixture = createFakePublisherFixture();
		const eve = await fixture.createPublisher({ did: "did:plc:eve000000000000000000000" });
		await eve.publishProfile({ slug: "x", license: "MIT", securityEmail: "x@y.test" });

		const res = await fixture.pds.handle(
			`/xrpc/com.atproto.sync.getRecord?did=${eve.did}&collection=${PROFILE_NSID}&rkey=x`,
			{ method: "GET" },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/vnd.ipld.car");

		const carBytes = new Uint8Array(await res.arrayBuffer());
		const publicKey = await loadPublicKey(eve.repo.didKey());
		const verified = await verifyRecord({
			did: eve.did,
			collection: PROFILE_NSID,
			rkey: "x",
			publicKey,
			carBytes,
		});
		expect((verified.record as { slug: string }).slug).toBe("x");
	});

	it("returns JSON for /xrpc/com.atproto.repo.listRecords", async () => {
		const fixture = createFakePublisherFixture();
		const frank = await fixture.createPublisher({ did: "did:plc:frank0000000000000000000" });
		await frank.publishProfile({ slug: "a", license: "MIT", securityEmail: "x@y.test" });
		await frank.publishProfile({ slug: "b", license: "MIT", securityEmail: "x@y.test" });

		const res = await fixture.pds.handle(
			`/xrpc/com.atproto.repo.listRecords?repo=${frank.did}&collection=${PROFILE_NSID}`,
			{ method: "GET" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { records: Array<{ uri: string }> };
		expect(body.records).toHaveLength(2);
		expect(body.records.map((r) => r.uri)).toContain(`at://${frank.did}/${PROFILE_NSID}/a`);
		expect(body.records.map((r) => r.uri)).toContain(`at://${frank.did}/${PROFILE_NSID}/b`);
	});

	it("returns an exclusion-proof CAR for a missing record (verifyRecord rejects)", async () => {
		// Real PDSes return 200 + a CAR containing an exclusion proof when
		// asked for a non-existent record (that's the spec). The CAR itself
		// is structurally valid; verifyRecord rejects because the record
		// can't be reached from the MST root. Confirm both halves of that
		// behaviour.
		const fixture = createFakePublisherFixture();
		const grace = await fixture.createPublisher({ did: "did:plc:grace0000000000000000000" });
		await grace.publishProfile({ slug: "real", license: "MIT", securityEmail: "x@y.test" });

		const res = await fixture.pds.handle(
			`/xrpc/com.atproto.sync.getRecord?did=${grace.did}&collection=${PROFILE_NSID}&rkey=missing`,
			{ method: "GET" },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/vnd.ipld.car");

		const carBytes = new Uint8Array(await res.arrayBuffer());
		const publicKey = await loadPublicKey(grace.repo.didKey());
		await expect(
			verifyRecord({
				did: grace.did,
				collection: PROFILE_NSID,
				rkey: "missing",
				publicKey,
				carBytes,
			}),
		).rejects.toThrow();
	});
});

describe("MockJetstream", () => {
	it("delivers emitted events to active subscribers", async () => {
		const fixture = createFakePublisherFixture();
		const sub = fixture.jetstream.subscribe({
			wantedCollections: [PROFILE_NSID],
		});

		fixture.jetstream.emitCommit({
			did: "did:plc:hank000000000000000000000",
			collection: PROFILE_NSID,
			rkey: "h",
		});

		const iter = sub[Symbol.asyncIterator]();
		const result = await iter.next();
		expect(result.done).toBe(false);
		expect(result.value?.kind).toBe("commit");
		if (result.value?.kind === "commit") {
			expect(result.value.commit.collection).toBe(PROFILE_NSID);
			expect(result.value.commit.rkey).toBe("h");
		}
		sub.close();
	});

	it("filters by wantedCollections", async () => {
		const fixture = createFakePublisherFixture();
		const sub = fixture.jetstream.subscribe({
			wantedCollections: [PROFILE_NSID],
		});

		fixture.jetstream.emitCommit({
			did: "did:plc:ivy000000000000000000000",
			collection: RELEASE_NSID,
			rkey: "ignored:1.0.0",
		});
		fixture.jetstream.emitCommit({
			did: "did:plc:ivy000000000000000000000",
			collection: PROFILE_NSID,
			rkey: "kept",
		});

		const iter = sub[Symbol.asyncIterator]();
		const result = await iter.next();
		if (result.value?.kind === "commit") {
			expect(result.value.commit.collection).toBe(PROFILE_NSID);
			expect(result.value.commit.rkey).toBe("kept");
		}
		sub.close();
	});

	it("replays history when a subscriber connects with cursor 0", async () => {
		const fixture = createFakePublisherFixture();
		fixture.jetstream.emitCommit({
			did: "did:plc:jack000000000000000000000",
			collection: PROFILE_NSID,
			rkey: "early",
		});

		const sub = fixture.jetstream.subscribe({});
		const iter = sub[Symbol.asyncIterator]();
		const result = await iter.next();
		if (result.value?.kind === "commit") {
			expect(result.value.commit.rkey).toBe("early");
		}
		sub.close();
	});
});

describe("MockDidResolver", () => {
	it("resolves a publisher's DID document and exposes the PDS endpoint", async () => {
		const fixture = createFakePublisherFixture({ pdsBaseUrl: "https://custom-pds.test" });
		const kim = await fixture.createPublisher({
			did: "did:plc:kim000000000000000000000",
			handle: "kim.test",
		});

		const doc = fixture.didResolver.resolve(kim.did);
		expect(doc?.id).toBe(kim.did);
		expect(fixture.didResolver.pdsFor(kim.did)).toBe("https://custom-pds.test");
		expect(fixture.didResolver.signingKeyFor(kim.did)).toBeTruthy();
	});

	it("returns null for an unknown DID", () => {
		const fixture = createFakePublisherFixture();
		expect(fixture.didResolver.resolve("did:plc:unknown00000000000000000")).toBeNull();
	});
});

// ── helpers ────────────────────────────────────────────────────────────────

async function loadPublicKey(didKey: string): Promise<P256PublicKey> {
	const parsed = parseDidKey(didKey);
	return P256PublicKey.importRaw(parsed.keyBytes);
}
