import { P256PrivateKeyExportable, Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { fromBase64Url, toBase58Btc } from "@atcute/multibase";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	type CachedLabelerIdentity,
	createD1LabelerIdentityCache,
	type LabelerDidResolverLike,
	type LabelerIdentityCache,
	LabelerResolver,
} from "../src/labeler-resolver.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const DID = "did:web:labeler.example";
const ENDPOINT = "https://labeler.example";
const NOW = new Date("2026-07-11T12:00:00.000Z");

let signingKey: string;
let otherSigningKey: string;
let wrongCurveKey: string;
let nonCanonicalKey: string;

beforeAll(async () => {
	const keypair = await P256PrivateKeyExportable.createKeypair();
	const otherKeypair = await P256PrivateKeyExportable.createKeypair();
	const secp256k1 = await Secp256k1PrivateKeyExportable.createKeypair();
	signingKey = await keypair.exportPublicKey("multikey");
	otherSigningKey = await otherKeypair.exportPublicKey("multikey");
	wrongCurveKey = await secp256k1.exportPublicKey("multikey");

	const jwk = await keypair.exportPublicKey("jwk");
	const uncompressed = new Uint8Array([
		0x80,
		0x24,
		0x04,
		...fromBase64Url(jwk.x!),
		...fromBase64Url(jwk.y!),
	]);
	nonCanonicalKey = `z${toBase58Btc(uncompressed)}`;
});

function document(overrides: Record<string, unknown> = {}): unknown {
	return {
		"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
		id: DID,
		verificationMethod: [
			{
				id: `${DID}#atproto_label`,
				type: "Multikey",
				controller: DID,
				publicKeyMultibase: signingKey,
			},
		],
		service: [
			{
				id: `${DID}#atproto_labeler`,
				type: "AtprotoLabeler",
				serviceEndpoint: ENDPOINT,
			},
		],
		...overrides,
	};
}

class MapCache implements LabelerIdentityCache {
	readonly entries = new Map<string, CachedLabelerIdentity>();
	readonly refreshes: Array<{
		did: string;
		identity: Omit<CachedLabelerIdentity, "resolvedAt">;
		now: Date;
	}> = [];
	readonly expires: string[] = [];

	read(did: string): Promise<CachedLabelerIdentity | null> {
		return Promise.resolve(this.entries.get(did) ?? null);
	}

	refresh(
		did: string,
		identity: Omit<CachedLabelerIdentity, "resolvedAt">,
		now: Date,
	): Promise<void> {
		if (!this.entries.has(did)) throw new Error("labeler is not configured");
		this.refreshes.push({ did, identity, now });
		this.entries.set(did, { ...identity, resolvedAt: now });
		return Promise.resolve();
	}

	expire(did: string): Promise<void> {
		this.expires.push(did);
		const cached = this.entries.get(did);
		if (cached) this.entries.set(did, { ...cached, resolvedAt: new Date(0) });
		return Promise.resolve();
	}
}

class StubResolver implements LabelerDidResolverLike {
	readonly calls: string[] = [];
	response: unknown = document();
	error: Error | null = null;

	resolve(did: string): Promise<unknown> {
		this.calls.push(did);
		if (this.error) return Promise.reject(this.error);
		return Promise.resolve(this.response);
	}
}

function configured(
	cache: MapCache,
	overrides: Partial<CachedLabelerIdentity> = {},
): CachedLabelerIdentity {
	const identity = {
		endpoint: "https://cached.example",
		signingKey,
		signingKeyId: `${DID}#atproto_label`,
		resolvedAt: NOW,
		...overrides,
	};
	cache.entries.set(DID, identity);
	return identity;
}

describe("LabelerResolver", () => {
	it("returns a fresh configured cache entry without fetching", async () => {
		const cache = new MapCache();
		const cached = configured(cache);
		const didResolver = new StubResolver();
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		const result = await subject.resolve(DID);

		expect(result.endpoint).toBe(cached.endpoint);
		expect(result.signingKeyId).toBe(`${DID}#atproto_label`);
		expect(typeof result.publicKey.verify).toBe("function");
		expect(didResolver.calls).toEqual([]);
	});

	it("rejects a noncanonical signing key ID in a fresh cache entry without fetching", async () => {
		const cache = new MapCache();
		configured(cache, { signingKeyId: `${DID}#other` });
		const didResolver = new StubResolver();
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await expect(subject.resolve(DID)).rejects.toThrow(/signing key id/i);
		expect(didResolver.calls).toEqual([]);
	});

	it("re-resolves a stale configured row and accepts relative canonical ids", async () => {
		const cache = new MapCache();
		configured(cache, { resolvedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) });
		const didResolver = new StubResolver();
		didResolver.response = document({
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: DID,
					publicKeyMultibase: otherSigningKey,
				},
			],
			service: [{ id: "#atproto_labeler", type: "AtprotoLabeler", serviceEndpoint: ENDPOINT }],
		});
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		const result = await subject.resolve(DID);

		expect(result.endpoint).toBe(ENDPOINT);
		expect(result.signingKeyId).toBe(`${DID}#atproto_label`);
		expect(didResolver.calls).toEqual([DID]);
		expect(cache.refreshes[0]).toMatchObject({
			did: DID,
			identity: {
				endpoint: ENDPOINT,
				signingKey: otherSigningKey,
				signingKeyId: `${DID}#atproto_label`,
			},
			now: NOW,
		});
	});

	it("rejects an unconfigured DID without fetching", async () => {
		const cache = new MapCache();
		const didResolver = new StubResolver();
		const subject = new LabelerResolver({ cache, resolver: didResolver });

		await expect(subject.resolve(DID)).rejects.toThrow(/not configured/i);
		expect(didResolver.calls).toEqual([]);
	});

	it("resolveFresh bypasses TTL but still requires a configured DID", async () => {
		const cache = new MapCache();
		configured(cache);
		const didResolver = new StubResolver();
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await subject.resolveFresh(DID);
		expect(didResolver.calls).toEqual([DID]);

		const unconfigured = new LabelerResolver({ cache: new MapCache(), resolver: didResolver });
		await expect(unconfigured.resolveFresh("did:web:other.example")).rejects.toThrow(
			/not configured/i,
		);
		expect(didResolver.calls).toEqual([DID]);
	});

	it("failed stale resolution preserves the prior cache and timestamp", async () => {
		const cache = new MapCache();
		const prior = configured(cache, { resolvedAt: new Date(0) });
		const didResolver = new StubResolver();
		didResolver.response = document({ service: [] });
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await expect(subject.resolve(DID)).rejects.toThrow(/atproto_labeler/i);
		expect(cache.entries.get(DID)).toEqual(prior);
		expect(cache.refreshes).toEqual([]);
	});

	it("resolver failure preserves the prior cache and timestamp", async () => {
		const cache = new MapCache();
		const prior = configured(cache, { resolvedAt: new Date(0) });
		const didResolver = new StubResolver();
		didResolver.error = new Error("DID resolver unavailable");
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await expect(subject.resolve(DID)).rejects.toThrow("DID resolver unavailable");
		expect(cache.entries.get(DID)).toEqual(prior);
		expect(cache.refreshes).toEqual([]);
	});

	it("invalidate expires only the configured row's freshness", async () => {
		const cache = new MapCache();
		const prior = configured(cache);
		const didResolver = new StubResolver();
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await subject.invalidate(DID);

		expect(cache.entries.get(DID)).toEqual({ ...prior, resolvedAt: new Date(0) });
		expect(cache.expires).toEqual([DID]);
	});

	it("invalidate makes the next resolve fetch and refresh", async () => {
		const cache = new MapCache();
		configured(cache);
		const didResolver = new StubResolver();
		didResolver.response = document({
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: DID,
					publicKeyMultibase: otherSigningKey,
				},
			],
		});
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await subject.invalidate(DID);
		const result = await subject.resolve(DID);

		expect(didResolver.calls).toEqual([DID]);
		expect(cache.refreshes).toHaveLength(1);
		expect(cache.refreshes[0]).toMatchObject({
			did: DID,
			identity: {
				signingKey: otherSigningKey,
				signingKeyId: `${DID}#atproto_label`,
			},
			now: NOW,
		});
		expect(result.signingKeyId).toBe(`${DID}#atproto_label`);
	});

	const invalidDocuments = [
		["a non-object document", () => null, /DID document must be an object/i],
		[
			"a mismatched document id",
			() => document({ id: "did:web:other.example" }),
			/id does not match/i,
		],
		["missing services", () => document({ service: [] }), /exactly one.*atproto_labeler/i],
		[
			"duplicate relative and absolute services",
			() =>
				document({
					service: [
						{ id: "#atproto_labeler", type: "AtprotoLabeler", serviceEndpoint: ENDPOINT },
						{
							id: `${DID}#atproto_labeler`,
							type: "AtprotoLabeler",
							serviceEndpoint: ENDPOINT,
						},
					],
				}),
			/exactly one.*atproto_labeler/i,
		],
		[
			"a wrong service type",
			() =>
				document({
					service: [{ id: "#atproto_labeler", type: "Other", serviceEndpoint: ENDPOINT }],
				}),
			/type AtprotoLabeler/i,
		],
		[
			"a service endpoint with credentials",
			() =>
				document({
					service: [
						{
							id: "#atproto_labeler",
							type: "AtprotoLabeler",
							serviceEndpoint: "https://user:pass@labeler.example",
						},
					],
				}),
			/credentials/i,
		],
		[
			"a service endpoint with a fragment",
			() =>
				document({
					service: [
						{
							id: "#atproto_labeler",
							type: "AtprotoLabeler",
							serviceEndpoint: "https://labeler.example/#fragment",
						},
					],
				}),
			/fragment/i,
		],
		[
			"a service endpoint with an empty fragment",
			() =>
				document({
					service: [
						{
							id: "#atproto_labeler",
							type: "AtprotoLabeler",
							serviceEndpoint: "https://labeler.example/#",
						},
					],
				}),
			/fragment/i,
		],
		[
			"a non-HTTPS service endpoint",
			() =>
				document({
					service: [
						{
							id: "#atproto_labeler",
							type: "AtprotoLabeler",
							serviceEndpoint: "http://labeler.example",
						},
					],
				}),
			/HTTPS/i,
		],
		[
			"missing verification methods",
			() => document({ verificationMethod: [] }),
			/exactly one.*atproto_label/i,
		],
		[
			"duplicate relative and absolute methods",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: DID,
							publicKeyMultibase: signingKey,
						},
						{
							id: `${DID}#atproto_label`,
							type: "Multikey",
							controller: DID,
							publicKeyMultibase: signingKey,
						},
					],
				}),
			/exactly one.*atproto_label/i,
		],
		[
			"a wrong verification method type",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "JsonWebKey2020",
							controller: DID,
							publicKeyMultibase: signingKey,
						},
					],
				}),
			/type Multikey/i,
		],
		[
			"a wrong verification method controller",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: "did:web:other.example",
							publicKeyMultibase: signingKey,
						},
					],
				}),
			/controller/i,
		],
		[
			"a malformed multikey",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: DID,
							publicKeyMultibase: "not-a-key",
						},
					],
				}),
			/invalid.*Multikey/i,
		],
		[
			"a non-P256 multikey",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: DID,
							publicKeyMultibase: wrongCurveKey,
						},
					],
				}),
			/P-256/i,
		],
		[
			"a non-canonical P256 multikey",
			() =>
				document({
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: DID,
							publicKeyMultibase: nonCanonicalKey,
						},
					],
				}),
			/canonical P-256/i,
		],
	] satisfies Array<readonly [string, () => unknown, RegExp]>;

	it.each(invalidDocuments)("rejects %s", async (_case, makeResponse, message) => {
		const cache = new MapCache();
		configured(cache, { resolvedAt: new Date(0) });
		const didResolver = new StubResolver();
		didResolver.response = makeResponse();
		const subject = new LabelerResolver({ cache, resolver: didResolver, now: () => NOW });

		await expect(subject.resolve(DID)).rejects.toThrow(message);
		expect(cache.refreshes).toEqual([]);
	});
});

describe("createD1LabelerIdentityCache", () => {
	beforeAll(async () => {
		await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	});

	beforeEach(async () => {
		await testEnv.DB.exec("DELETE FROM labelers");
	});

	async function insertLabeler(overrides: Record<string, unknown> = {}): Promise<void> {
		const row = {
			did: DID,
			endpoint: "https://cached.example",
			signingKey,
			signingKeyId: `${DID}#atproto_label`,
			trusted: 1,
			addedAt: "2026-07-01T00:00:00.000Z",
			resolvedAt: "2026-07-01T00:00:00.000Z",
			notes: "operator note",
			...overrides,
		};
		await testEnv.DB.prepare(
			`INSERT INTO labelers
			   (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at, notes)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				row.did,
				row.endpoint,
				row.signingKey,
				row.signingKeyId,
				row.trusted,
				row.addedAt,
				row.resolvedAt,
				row.notes,
			)
			.run();
	}

	it("uses labelers as an allowlist and round-trips cached identity", async () => {
		const cache = createD1LabelerIdentityCache(testEnv.DB);
		expect(await cache.read(DID)).toBeNull();

		await insertLabeler();
		expect(await cache.read(DID)).toEqual({
			endpoint: "https://cached.example",
			signingKey,
			signingKeyId: `${DID}#atproto_label`,
			resolvedAt: new Date("2026-07-01T00:00:00.000Z"),
		});
	});

	it("refresh updates only cache fields and preserves operator metadata", async () => {
		await insertLabeler();
		const cache = createD1LabelerIdentityCache(testEnv.DB);

		await cache.refresh(
			DID,
			{
				endpoint: ENDPOINT,
				signingKey: otherSigningKey,
				signingKeyId: `${DID}#atproto_label`,
			},
			NOW,
		);

		const row = await testEnv.DB.prepare("SELECT * FROM labelers WHERE did = ?").bind(DID).first();
		expect(row).toMatchObject({
			endpoint: ENDPOINT,
			signing_key: otherSigningKey,
			signing_key_id: `${DID}#atproto_label`,
			last_resolved_at: NOW.toISOString(),
			trusted: 1,
			added_at: "2026-07-01T00:00:00.000Z",
			notes: "operator note",
		});
	});

	it("refresh cannot insert an unconfigured DID", async () => {
		const cache = createD1LabelerIdentityCache(testEnv.DB);

		await expect(
			cache.refresh(
				DID,
				{ endpoint: ENDPOINT, signingKey, signingKeyId: `${DID}#atproto_label` },
				NOW,
			),
		).rejects.toThrow(/not configured/i);
		expect(await testEnv.DB.prepare("SELECT did FROM labelers").first()).toBeNull();
	});

	it("expire changes only last_resolved_at", async () => {
		await insertLabeler();
		const before = await testEnv.DB.prepare("SELECT * FROM labelers WHERE did = ?")
			.bind(DID)
			.first();
		const cache = createD1LabelerIdentityCache(testEnv.DB);

		await cache.expire(DID);

		const after = await testEnv.DB.prepare("SELECT * FROM labelers WHERE did = ?")
			.bind(DID)
			.first();
		expect(after).toEqual({ ...before, last_resolved_at: "1970-01-01T00:00:00.000Z" });
	});

	it("failed real-D1 refresh preserves the prior cache and timestamp", async () => {
		await insertLabeler();
		const didResolver = new StubResolver();
		didResolver.response = document({ service: [] });
		const subject = new LabelerResolver({
			cache: createD1LabelerIdentityCache(testEnv.DB),
			resolver: didResolver,
			now: () => NOW,
		});
		const before = await testEnv.DB.prepare("SELECT * FROM labelers WHERE did = ?")
			.bind(DID)
			.first();

		await expect(subject.resolve(DID)).rejects.toThrow(/atproto_labeler/i);

		const after = await testEnv.DB.prepare("SELECT * FROM labelers WHERE did = ?")
			.bind(DID)
			.first();
		expect(after).toEqual(before);
	});
});
