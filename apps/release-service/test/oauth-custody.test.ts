import { OAuthClient, type StoredSession, type StoredState } from "@atcute/oauth-node-client";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import {
	OAuthCustodyError,
	OAuthCustodyRepository,
	createOAuthStores,
	type OAuthStoreOptions,
} from "../src/oauth/store.js";
import { ASSERTION_KEY_1, ASSERTION_KEY_2, TEST_BINDINGS } from "./fixtures/oauth.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const DID = "did:plc:publisher" as const;
const OTHER_DID = "did:plc:other" as const;
const DPOP_KEY = {
	kty: "EC",
	x: "DKas1cwlMQB8YyJdRR_vvenYaiPOG_m49pW7T5xo2Nk",
	y: "Q7Nbp2qHt66StC3qX4Lv82BYysuTtzwJ9UON04KywYo",
	crv: "P-256",
	d: "cVdiepgRpynyyhZIV1wEY4P7nr3kVSGn70uP6ng1QUw",
	alg: "ES256",
} as const;

function storedState(
	redirectTarget = "/delegations",
	expiresAt = Date.now() + 10 * 60_000,
): StoredState {
	return {
		dpopKey: DPOP_KEY,
		authMethod: { method: "private_key_jwt", kid: ASSERTION_KEY_2.kid },
		pkceVerifier: "pkce-secret",
		issuer: "https://pds.example.com",
		redirectUri: TEST_BINDINGS.PUBLIC_ORIGIN + "/oauth/callback",
		sub: DID,
		userState: { redirectTarget },
		expiresAt,
	};
}

function storedSession(accessToken = "access-secret"): StoredSession {
	return {
		dpopKey: DPOP_KEY,
		authMethod: { method: "private_key_jwt", kid: ASSERTION_KEY_2.kid },
		tokenSet: {
			iss: "https://pds.example.com",
			sub: DID,
			aud: "https://pds.example.com",
			scope: "atproto repo:com.emdashcms.experimental.package.release?action=create",
			access_token: accessToken,
			refresh_token: "refresh-secret",
			token_type: "DPoP",
			expires_at: Date.now() + 60_000,
		},
	};
}

function identitySession(accessToken: string): StoredSession {
	return {
		...storedSession(accessToken),
		tokenSet: { ...storedSession(accessToken).tokenSet, scope: "atproto" },
	};
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

async function createRepository(bindings = TEST_BINDINGS) {
	const configuration = await loadConfiguration(bindings);
	return {
		configuration,
		repository: new OAuthCustodyRepository(
			testEnv.DB,
			configuration.encryption,
			configuration.oauth,
		),
	};
}

describe("OAuth custody D1 repository", () => {
	it("round trips authorization state while storing only a hash and ciphertext", async () => {
		const { repository } = await createRepository();
		await repository.upsertPublisher({ did: DID });
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		const state = storedState();

		await stores.states.set("opaque-state-token", state);
		const row = await testEnv.DB.prepare(
			"SELECT state_hash, encrypted_state FROM oauth_transactions WHERE purpose = ? AND expected_did = ?",
		)
			.bind("release_delegation", DID)
			.first<{ state_hash: string; encrypted_state: string }>();
		expect(row?.state_hash).not.toBe("opaque-state-token");
		expect(row?.encrypted_state).not.toContain("pkce-secret");
		expect(row?.encrypted_state).not.toContain("refresh-secret");
		expect(await stores.states.get("opaque-state-token")).toEqual(state);

		await stores.states.delete("opaque-state-token");
		expect(await stores.states.get("opaque-state-token")).toBeUndefined();
	});

	it("atomically consumes authorization state and binds its redirect target", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: DID,
			redirectTarget: "/console",
		});
		await expect(
			stores.states.set("mismatched-state", storedState("/other")),
		).rejects.toMatchObject({ code: "OAUTH_REDIRECT_INVALID" });
		await stores.states.set("single-use-state", storedState("/console"));
		const wrongRedirectStores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: DID,
			redirectTarget: "/other",
		});
		expect(await wrongRedirectStores.states.get("single-use-state")).toBeUndefined();

		const results = await Promise.all([
			stores.states.get("single-use-state"),
			stores.states.get("single-use-state"),
		]);
		expect(results.filter((result) => result !== undefined)).toHaveLength(1);
	});

	it.each([
		"//attacker.example",
		"/\\attacker.example",
		"/safe\r\nLocation: evil",
		"https://evil.example",
	])("rejects unsafe redirect target %s", async (redirectTarget) => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: null,
			redirectTarget,
		});
		await expect(
			stores.states.set(`unsafe-${redirectTarget}`, storedState(redirectTarget)),
		).rejects.toMatchObject({ code: "OAUTH_REDIRECT_INVALID" });
	});

	it("canonicalizes the bound redirect target against the public origin", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: null,
			redirectTarget: "/console/../delegations?tab=oauth#active",
		});
		await stores.states.set(
			"canonical-redirect",
			storedState("/console/../delegations?tab=oauth#active"),
		);
		expect((await stores.states.get("canonical-redirect"))?.userState).toEqual({
			redirectTarget: "/delegations?tab=oauth#active",
		});
	});

	it("isolates identical identities and state material by OAuth purpose", async () => {
		const { repository } = await createRepository();
		const consoleStores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: DID,
			redirectTarget: "/",
		});
		const approverStores = createOAuthStores(repository, {
			purpose: "approver_identity",
			expectedDid: DID,
			redirectTarget: "/approve",
		});
		await consoleStores.states.set("console-state", storedState("/"));
		await approverStores.states.set("approver-state", storedState("/approve"));
		await expect(
			approverStores.states.set("console-state", storedState("/approve")),
		).rejects.toThrow();

		expect(await consoleStores.states.get("approver-state")).toBeUndefined();
		expect(await approverStores.states.get("console-state")).toBeUndefined();

		await consoleStores.sessions.set(DID, identitySession("console-token"));
		await approverStores.sessions.set(DID, identitySession("approver-token"));
		expect((await consoleStores.sessions.get(DID))?.tokenSet.access_token).toBe("console-token");
		expect((await approverStores.sessions.get(DID))?.tokenSet.access_token).toBe("approver-token");
		await consoleStores.sessions.delete(DID);
		expect(await consoleStores.sessions.get(DID)).toBeUndefined();
		expect(await approverStores.sessions.get(DID)).toBeDefined();
		const durableSessions = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM delegations WHERE publisher_did = ?",
		)
			.bind(DID)
			.first<{ count: number }>();
		expect(durableSessions?.count).toBe(0);
	});

	it("restricts transient identity sessions to the expected DID and atproto-only scope", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "approver_identity",
			expectedDid: DID,
			redirectTarget: "/approve",
		});

		expect(() => stores.sessions.set(DID, storedSession())).toThrowError(
			expect.objectContaining({
				code: "OAUTH_SCOPE_INVALID",
			}),
		);
		expect(() => stores.sessions.set(OTHER_DID, identitySession("other"))).toThrowError(
			expect.objectContaining({ code: "OAUTH_IDENTITY_MISMATCH" }),
		);
		expect(() =>
			stores.sessions.set(DID, {
				...identitySession("wrong-sub"),
				tokenSet: { ...identitySession("wrong-sub").tokenSet, sub: OTHER_DID },
			}),
		).toThrowError(expect.objectContaining({ code: "OAUTH_IDENTITY_MISMATCH" }));
	});

	it("cryptographically binds authorization ciphertext to its logical purpose", async () => {
		const { repository } = await createRepository();
		const consoleStores = createOAuthStores(repository, {
			purpose: "console_login",
			expectedDid: DID,
			redirectTarget: "/",
		});
		await consoleStores.states.set("purpose-bound-state", storedState("/"));
		const row = await testEnv.DB.prepare(
			"SELECT id FROM oauth_transactions WHERE purpose = ? AND expected_did = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind("console_login", DID)
			.first<{ id: string }>();
		await testEnv.DB.prepare("UPDATE oauth_transactions SET purpose = ? WHERE id = ?")
			.bind("approver_identity", row!.id)
			.run();
		const approverStores = createOAuthStores(repository, {
			purpose: "approver_identity",
			expectedDid: DID,
			redirectTarget: "/",
		});
		await expect(approverStores.states.get("purpose-bound-state")).rejects.toMatchObject({
			code: "DECRYPTION_FAILED",
		});
	});

	it("returns a stable typed reauthorization failure when an assertion key disappeared", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		await stores.states.set("rotated-state", storedState());

		const oldOnlyBindings = {
			...TEST_BINDINGS,
			OAUTH_ASSERTION_KEYSET: JSON.stringify({
				active: ASSERTION_KEY_1.kid,
				keys: [ASSERTION_KEY_1],
			}),
		};
		const { repository: rotatedRepository } = await createRepository(oldOnlyBindings);
		const rotatedStores = createOAuthStores(rotatedRepository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});

		await expect(rotatedStores.states.get("rotated-state")).rejects.toMatchObject({
			code: "OAUTH_CLIENT_KEY_UNAVAILABLE",
			reauthorizationRequired: true,
		});
	});

	it("deletes expired authorization state on read", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "approver_identity",
			expectedDid: DID,
			redirectTarget: "/approve",
		});
		await stores.states.set("expired-state", storedState("/approve", Date.now() - 1));
		expect(await stores.states.get("expired-state")).toBeUndefined();
		const row = await testEnv.DB.prepare(
			"SELECT id FROM oauth_transactions WHERE purpose = ? AND expected_did = ? AND expires_at <= ?",
		)
			.bind("approver_identity", DID, new Date().toISOString())
			.first();
		expect(row).toBeNull();
	});

	it("hashes console tokens and encrypts CSRF secrets with ownership and expiry", async () => {
		const { repository } = await createRepository();
		await repository.upsertPublisher({ did: OTHER_DID });
		const session = await repository.createConsoleSession({
			publisherDid: OTHER_DID,
			token: "browser-session-secret",
			csrfSecret: "csrf-secret",
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await repository.getConsoleSession("browser-session-secret", OTHER_DID)).toMatchObject({
			id: session.id,
			publisherDid: OTHER_DID,
			csrfSecret: "csrf-secret",
		});
		expect(await repository.getConsoleSession("browser-session-secret", DID)).toBeUndefined();

		const row = await testEnv.DB.prepare(
			"SELECT token_hash, encrypted_csrf_secret FROM console_sessions WHERE id = ?",
		)
			.bind(session.id)
			.first<{ token_hash: string; encrypted_csrf_secret: string }>();
		expect(row?.token_hash).not.toBe("browser-session-secret");
		expect(row?.encrypted_csrf_secret).not.toContain("csrf-secret");

		await repository.createConsoleSession({
			publisherDid: OTHER_DID,
			token: "expired-browser-session",
			csrfSecret: "expired-csrf",
			expiresAt: new Date(Date.now() - 1),
		});
		expect(
			await repository.getConsoleSession("expired-browser-session", OTHER_DID),
		).toBeUndefined();
		await expect(
			repository.createConsoleSession({
				publisherDid: OTHER_DID,
				token: "browser-session-secret",
				csrfSecret: "another-csrf",
				expiresAt: new Date(Date.now() + 60_000),
			}),
		).rejects.toThrow();
	});

	it("preserves omitted publisher cache fields and updates or clears the PDS tuple atomically", async () => {
		const { repository } = await createRepository();
		const resolvedAt = new Date("2026-07-01T12:00:00.000Z");
		await repository.upsertPublisher({
			did: DID,
			handle: "publisher.example",
			pdsUrl: "https://pds.example",
			pdsResolvedAt: resolvedAt,
		});
		await repository.upsertPublisher({ did: DID });
		let row = await testEnv.DB.prepare(
			"SELECT handle, pds_url, pds_resolved_at FROM publisher_accounts WHERE did = ?",
		)
			.bind(DID)
			.first<{ handle: string | null; pds_url: string | null; pds_resolved_at: string | null }>();
		expect(row).toEqual({
			handle: "publisher.example",
			pds_url: "https://pds.example",
			pds_resolved_at: resolvedAt.toISOString(),
		});

		await expect(
			repository.upsertPublisher({
				did: DID,
				pdsUrl: "https://replacement-pds.example",
			} as Parameters<typeof repository.upsertPublisher>[0]),
		).rejects.toThrow(TypeError);
		await repository.upsertPublisher({ did: DID, handle: "new.example", pdsUrl: null });
		row = await testEnv.DB.prepare(
			"SELECT handle, pds_url, pds_resolved_at FROM publisher_accounts WHERE did = ?",
		)
			.bind(DID)
			.first<{ handle: string | null; pds_url: string | null; pds_resolved_at: string | null }>();
		expect(row).toEqual({
			handle: "new.example",
			pds_url: null,
			pds_resolved_at: null,
		});

		await repository.upsertPublisher({
			did: DID,
			pdsUrl: "https://replacement-pds.example",
			pdsResolvedAt: resolvedAt,
		});
		await repository.upsertPublisher({ did: DID, pdsResolvedAt: null });
		row = await testEnv.DB.prepare(
			"SELECT handle, pds_url, pds_resolved_at FROM publisher_accounts WHERE did = ?",
		)
			.bind(DID)
			.first<{ handle: string | null; pds_url: string | null; pds_resolved_at: string | null }>();
		expect(row).toEqual({
			handle: "new.example",
			pds_url: null,
			pds_resolved_at: null,
		});
	});

	it("persists only the durable release session and keeps DPoP material encrypted", async () => {
		const { repository } = await createRepository();
		await repository.upsertPublisher({ did: DID });
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		const session = storedSession();
		await stores.sessions.set(DID, session);
		expect(await stores.sessions.get(DID)).toEqual(session);
		const oldOnlyBindings = {
			...TEST_BINDINGS,
			PUBLIC_ORIGIN: "https://release.example.com",
			ALLOWED_ORIGINS: '["https://release.example.com"]',
			OAUTH_REDIRECT_URIS: '["https://release.example.com/oauth/callback"]',
			OAUTH_ASSERTION_KEYSET: JSON.stringify({
				active: ASSERTION_KEY_1.kid,
				keys: [ASSERTION_KEY_1],
			}),
		};
		const { repository: rotatedRepository } = await createRepository(oldOnlyBindings);
		const rotatedStores = createOAuthStores(rotatedRepository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		const client = new OAuthClient({
			metadata: (await loadConfiguration(oldOnlyBindings)).oauth.clientMetadata,
			keyset: (await loadConfiguration(oldOnlyBindings)).oauth.keyset,
			actorResolver: {} as never,
			stores: rotatedStores,
		});
		await expect(client.restore(DID, { refresh: false })).rejects.toThrow();

		const row = await testEnv.DB.prepare(
			"SELECT id, encrypted_session, client_key_id, status, state_version FROM delegations WHERE publisher_did = ?",
		)
			.bind(DID)
			.first<{
				id: string;
				encrypted_session: string;
				client_key_id: string;
				status: string;
				state_version: number;
			}>();
		expect(row).toMatchObject({
			client_key_id: ASSERTION_KEY_2.kid,
			status: "reauthorization_required",
			state_version: 2,
		});
		expect(row?.encrypted_session).not.toContain("refresh-secret");
		expect(row?.encrypted_session).not.toContain(DPOP_KEY.d);

		expect(await repository.getDelegation(row!.id, OTHER_DID)).toBeUndefined();
		await stores.sessions.delete(DID);
		const revoked = await testEnv.DB.prepare(
			"SELECT status, encrypted_session, revoked_at FROM delegations WHERE id = ?",
		)
			.bind(row!.id)
			.first<{ status: string; encrypted_session: string | null; revoked_at: string | null }>();
		expect(revoked).toMatchObject({ status: "revoked", encrypted_session: null });
		expect(revoked?.revoked_at).not.toBeNull();
	});

	it("enforces one non-revoked grant and unique opaque credentials", async () => {
		const { configuration, repository } = await createRepository();
		await repository.upsertPublisher({ did: "did:plc:constraints" });
		const now = new Date().toISOString();
		const scope = configuration.oauth.releaseScope;
		const statement = (id: string) =>
			testEnv.DB.prepare(
				`INSERT INTO delegations (
					id, publisher_did, release_nsid, encrypted_session, encryption_key_version,
					client_key_id, scope, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
			).bind(
				id,
				"did:plc:constraints",
				configuration.oauth.releaseNsid,
				"encrypted",
				1,
				ASSERTION_KEY_2.kid,
				scope,
				now,
				now,
			);
		await statement("01J00000000000000000000001").run();
		await expect(statement("01J00000000000000000000002").run()).rejects.toThrow();
	});

	it("replaces a delegation after reauthorization is required", async () => {
		const { repository } = await createRepository();
		await repository.upsertPublisher({ did: DID });
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		await stores.sessions.set(DID, storedSession());
		const original = await repository.getDelegationByPublisher(DID);

		const key1OnlyBindings = {
			...TEST_BINDINGS,
			OAUTH_ASSERTION_KEYSET: JSON.stringify({
				active: ASSERTION_KEY_1.kid,
				keys: [ASSERTION_KEY_1],
			}),
		};
		const { repository: rotatedRepository } = await createRepository(key1OnlyBindings);
		const rotatedStores = createOAuthStores(rotatedRepository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		await expect(rotatedStores.sessions.get(DID)).rejects.toMatchObject({
			code: "OAUTH_CLIENT_KEY_UNAVAILABLE",
		});

		const reauthorized = {
			...storedSession("reauthorized-access"),
			authMethod: { method: "private_key_jwt" as const, kid: ASSERTION_KEY_1.kid },
		};
		await rotatedStores.sessions.set(DID, reauthorized);

		const replacement = await rotatedRepository.getDelegationByPublisher(DID);
		expect(replacement).toMatchObject({
			id: original!.id,
			client_key_id: ASSERTION_KEY_1.kid,
			status: "active",
			state_version: 3,
		});
		expect(await rotatedStores.sessions.get(DID)).toEqual(reauthorized);
	});

	it("provides owner-bound delegation CAS and lease persistence for refresh coordination", async () => {
		const { repository } = await createRepository();
		await repository.upsertPublisher({ did: "did:plc:lease" });
		const leaseDid = "did:plc:lease" as const;
		const session = {
			...storedSession(),
			tokenSet: { ...storedSession().tokenSet, sub: leaseDid },
		};
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: leaseDid,
			redirectTarget: "/delegations",
		});
		await stores.sessions.set(leaseDid, session);
		const delegation = await repository.getDelegationByPublisher(leaseDid);
		const leaseExpiresAt = new Date(Date.now() + 30_000);

		expect(
			await repository.claimDelegationLeaseCas({
				id: delegation!.id,
				publisherDid: OTHER_DID,
				expectedVersion: 1,
				leaseOwner: "worker-a",
				leaseExpiresAt,
			}),
		).toBe(false);
		expect(
			await repository.claimDelegationLeaseCas({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 1,
				leaseOwner: "worker-a",
				leaseExpiresAt,
			}),
		).toBe(true);
		expect(await stores.sessions.get(leaseDid)).toBeUndefined();
		expect(
			await repository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 1,
				leaseOwner: "worker-a",
			}),
		).toBeUndefined();
		expect(
			await repository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 2,
				leaseOwner: "wrong-worker",
			}),
		).toBeUndefined();
		expect(
			await repository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 2,
				leaseOwner: "worker-a",
			}),
		).toEqual(session);
		const rotated = { ...session, tokenSet: { ...session.tokenSet, access_token: "rotated" } };
		expect(
			await repository.storeDelegationSessionCas({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 2,
				leaseOwner: "wrong-worker",
				session: rotated,
				refreshBefore: new Date(Date.now() + 45_000),
			}),
		).toBe(false);
		expect(
			await repository.storeDelegationSessionCas({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 2,
				leaseOwner: "worker-a",
				session: rotated,
				refreshBefore: new Date(Date.now() + 45_000),
			}),
		).toBe(true);
		expect((await stores.sessions.get(leaseDid))?.tokenSet.access_token).toBe("rotated");
		expect(
			await repository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid: leaseDid,
				expectedVersion: 2,
				leaseOwner: "worker-a",
			}),
		).toBeUndefined();
	});

	it("does not let jobs for another release namespace claim or persist a delegation", async () => {
		const { repository } = await createRepository();
		const publisherDid = "did:plc:legacy-namespace" as const;
		await repository.upsertPublisher({ did: publisherDid });
		const session = {
			...storedSession(),
			tokenSet: { ...storedSession().tokenSet, sub: publisherDid },
		};
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: publisherDid,
			redirectTarget: "/delegations",
		});
		await stores.sessions.set(publisherDid, session);
		const delegation = await repository.getDelegationByPublisher(publisherDid);
		await testEnv.DB.prepare("UPDATE delegations SET release_nsid = ? WHERE id = ?")
			.bind("com.example.legacy.release", delegation!.id)
			.run();

		expect(
			await repository.claimDelegationLeaseCas({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 1,
				leaseOwner: "stale-worker",
				leaseExpiresAt: new Date(Date.now() + 30_000),
			}),
		).toBe(false);
		await testEnv.DB.prepare(
			`UPDATE delegations SET status = 'refreshing', state_version = 2,
				lease_owner = ?, lease_expires_at = ? WHERE id = ?`,
		)
			.bind("stale-worker", new Date(Date.now() + 30_000).toISOString(), delegation!.id)
			.run();
		const rotated = { ...session, tokenSet: { ...session.tokenSet, access_token: "rotated" } };
		expect(
			await repository.storeDelegationSessionCas({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 2,
				leaseOwner: "stale-worker",
				session: rotated,
				refreshBefore: new Date(Date.now() + 45_000),
			}),
		).toBe(false);
		const row = await testEnv.DB.prepare(
			"SELECT release_nsid, status, state_version FROM delegations WHERE id = ?",
		)
			.bind(delegation!.id)
			.first<{ release_nsid: string; status: string; state_version: number }>();
		expect(row).toEqual({
			release_nsid: "com.example.legacy.release",
			status: "refreshing",
			state_version: 2,
		});
	});

	it("rejects expired and excessively long delegation leases without changing the row", async () => {
		const { repository } = await createRepository();
		const publisherDid = "did:plc:expired-lease" as const;
		await repository.upsertPublisher({ did: publisherDid });
		const session = {
			...storedSession(),
			tokenSet: { ...storedSession().tokenSet, sub: publisherDid },
		};
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: publisherDid,
			redirectTarget: "/delegations",
		});
		await stores.sessions.set(publisherDid, session);
		const delegation = await repository.getDelegationByPublisher(publisherDid);
		expect(
			await repository.claimDelegationLeaseCas({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 1,
				leaseOwner: "expired-worker",
				leaseExpiresAt: new Date(Date.now() - 1),
			}),
		).toBe(false);
		expect(
			await repository.claimDelegationLeaseCas({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 1,
				leaseOwner: "long-worker",
				leaseExpiresAt: new Date(Date.now() + 5 * 60_000 + 1_000),
			}),
		).toBe(false);
		const row = await testEnv.DB.prepare(
			"SELECT status, state_version, lease_owner, lease_expires_at FROM delegations WHERE id = ?",
		)
			.bind(delegation!.id)
			.first<{
				status: string;
				state_version: number;
				lease_owner: string | null;
				lease_expires_at: string | null;
			}>();
		expect(row).toEqual({
			status: "active",
			state_version: 1,
			lease_owner: null,
			lease_expires_at: null,
		});
		expect(await stores.sessions.get(publisherDid)).toEqual(session);
	});

	it("transitions a leased delegation when its client key is unavailable", async () => {
		const { repository } = await createRepository();
		const publisherDid = "did:plc:missing-refresh-key" as const;
		await repository.upsertPublisher({ did: publisherDid });
		const session = {
			...storedSession(),
			tokenSet: { ...storedSession().tokenSet, sub: publisherDid },
		};
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: publisherDid,
			redirectTarget: "/delegations",
		});
		await stores.sessions.set(publisherDid, session);
		const delegation = await repository.getDelegationByPublisher(publisherDid);
		await repository.claimDelegationLeaseCas({
			id: delegation!.id,
			publisherDid,
			expectedVersion: 1,
			leaseOwner: "refresh-worker",
			leaseExpiresAt: new Date(Date.now() + 30_000),
		});
		const { repository: rotatedRepository } = await createRepository({
			...TEST_BINDINGS,
			OAUTH_ASSERTION_KEYSET: JSON.stringify({
				active: ASSERTION_KEY_1.kid,
				keys: [ASSERTION_KEY_1],
			}),
		});

		await expect(
			rotatedRepository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 2,
				leaseOwner: "refresh-worker",
			}),
		).rejects.toMatchObject({ code: "OAUTH_CLIENT_KEY_UNAVAILABLE" });
		const row = await testEnv.DB.prepare(
			"SELECT status, state_version, lease_owner, lease_expires_at FROM delegations WHERE id = ?",
		)
			.bind(delegation!.id)
			.first<{
				status: string;
				state_version: number;
				lease_owner: string | null;
				lease_expires_at: string | null;
			}>();
		expect(row).toEqual({
			status: "reauthorization_required",
			state_version: 3,
			lease_owner: null,
			lease_expires_at: null,
		});
		expect(
			await rotatedRepository.getDelegationSessionForRefresh({
				id: delegation!.id,
				publisherDid,
				expectedVersion: 2,
				leaseOwner: "refresh-worker",
			}),
		).toBeUndefined();
	});

	it("rejects nullable identity-purpose options at runtime", async () => {
		const { repository } = await createRepository();
		expect(() =>
			createOAuthStores(repository, {
				purpose: "approver_identity",
				expectedDid: null,
				redirectTarget: "/approve",
			} as unknown as OAuthStoreOptions),
		).toThrowError(expect.objectContaining({ code: "OAUTH_IDENTITY_MISMATCH" }));
	});

	it("rejects public-client auth and mismatched exact release scopes", async () => {
		const { repository } = await createRepository();
		const stores = createOAuthStores(repository, {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/delegations",
		});
		await expect(
			stores.sessions.set(DID, {
				...storedSession(),
				authMethod: { method: "none" },
			}),
		).rejects.toBeInstanceOf(OAuthCustodyError);
		await expect(
			stores.sessions.set(DID, {
				...storedSession(),
				tokenSet: { ...storedSession().tokenSet, scope: "atproto transition:generic" },
			}),
		).rejects.toMatchObject({ code: "OAUTH_SCOPE_INVALID" });
		await expect(
			stores.sessions.set(DID, {
				...storedSession(),
				dpopKey: ASSERTION_KEY_2,
			}),
		).rejects.toMatchObject({ code: "OAUTH_SESSION_INVALID" });
	});
});

describe("OAuth store option types", () => {
	it("permits nullable expected DIDs only for console login", () => {
		expectTypeOf<{
			purpose: "console_login";
			expectedDid: null;
			redirectTarget: "/";
		}>().toMatchTypeOf<OAuthStoreOptions>();
		expectTypeOf<{
			purpose: "approver_identity";
			expectedDid: null;
			redirectTarget: "/";
		}>().not.toMatchTypeOf<OAuthStoreOptions>();
		expectTypeOf<{
			purpose: "release_delegation";
			expectedDid: null;
			redirectTarget: "/";
		}>().not.toMatchTypeOf<OAuthStoreOptions>();
	});
});
