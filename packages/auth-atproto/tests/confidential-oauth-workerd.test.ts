import { generateClientAssertionKey } from "@atcute/oauth-node-client";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { D1OAuthPersistence } from "./support/confidential-oauth/d1-persistence.js";
import {
	AS_ORIGIN,
	CLIENT_ID,
	JWKS_URI,
	NEW_DID,
	OLD_DID,
	OAuthServerFixture,
	RELEASE_SCOPE,
	authorizeAndCallback,
	createConfidentialClient,
	decodeJwtPart,
	readStoredSession,
	readStoredState,
} from "./support/confidential-oauth/oauth-fixture.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await testEnv.DB.batch([
		testEnv.DB.prepare("DELETE FROM oauth_values"),
		testEnv.DB.prepare("DELETE FROM oauth_session_leases"),
	]);
});

describe("confidential atproto OAuth custody in workerd", () => {
	it("uses private_key_jwt, distinct DPoP keys, public JWKS, and D1-restorable state/session data", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		const authorizingClient = createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);

		expect(authorizingClient.metadata).toMatchObject({
			client_id: CLIENT_ID,
			scope: RELEASE_SCOPE,
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "ES256",
			dpop_bound_access_tokens: true,
			jwks_uri: JWKS_URI,
		});
		expect(authorizingClient.jwks?.keys).toHaveLength(1);
		expect(authorizingClient.jwks?.keys[0]).toMatchObject({ kid: "assertion-old", alg: "ES256" });
		expect(authorizingClient.jwks?.keys[0]).not.toHaveProperty("d");

		const { stateId } = await authorizingClient.authorize({
			target: { type: "pds", serviceUrl: "https://pds.emdashcms.com" },
		});
		expect(server.parRequests).toHaveLength(2);
		expect(server.parRequests[0]?.body.get("scope")).toBe(RELEASE_SCOPE);
		expect(decodeJwtPart(server.parRequests[1]!.dpop, 1)).toMatchObject({ nonce: "par-nonce" });

		const assertion = server.parRequests[1]?.body.get("client_assertion");
		expect(assertion).toBeTruthy();
		expect(decodeJwtPart(assertion!, 0)).toMatchObject({ alg: "ES256", kid: "assertion-old" });
		expect(decodeJwtPart(assertion!, 1)).toMatchObject({
			iss: CLIENT_ID,
			sub: CLIENT_ID,
			aud: AS_ORIGIN,
		});

		const dpopPublicKey = decodeJwtPart(server.parRequests[1]!.dpop, 0).jwk;
		expect(dpopPublicKey).not.toEqual(authorizingClient.jwks?.keys[0]);
		expect(dpopPublicKey).not.toHaveProperty("kid", "assertion-old");

		const storedState = await readStoredState(testEnv.DB, stateId);
		expect(storedState).toMatchObject({
			authMethod: { method: "private_key_jwt", kid: "assertion-old" },
			issuer: AS_ORIGIN,
			redirectUri: "https://release.emdashcms.com/oauth/callback",
		});
		expect(storedState?.dpopKey).toHaveProperty("d");
		expect(storedState?.pkceVerifier).toEqual(expect.any(String));

		const callbackClient = createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		await callbackClient.callback(
			new URLSearchParams({ state: stateId, code: "old-code", iss: AS_ORIGIN }),
		);
		expect(await readStoredState(testEnv.DB, stateId)).toBeUndefined();
		expect(server.tokenRequests[0]?.body.get("client_assertion_type")).toBe(
			"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		);
		expect(decodeJwtPart(server.tokenRequests[0]!.dpop, 1)).toMatchObject({ nonce: "par-nonce" });

		const storedSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(storedSession).toMatchObject({
			authMethod: { method: "private_key_jwt", kid: "assertion-old" },
			tokenSet: {
				iss: AS_ORIGIN,
				sub: OLD_DID,
				aud: "https://pds.emdashcms.com",
				scope: RELEASE_SCOPE,
				access_token: `access-${OLD_DID}`,
				refresh_token: `refresh-${OLD_DID}-0`,
				token_type: "DPoP",
			},
		});
		expect(storedSession?.dpopKey).toEqual(storedState?.dpopKey);

		const restored = await createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		).restore(OLD_DID, { refresh: false });
		expect((await restored.getTokenInfo(false)).scope).toBe(RELEASE_SCOPE);
	});

	it("allows ownerless session creation but rejects ownerless overwrite and real atcute sign-out deletion", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		const { session } = await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const originalSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(originalSession).toBeDefined();

		const persistence = new D1OAuthPersistence(testEnv.DB);
		const overwrite = structuredClone(originalSession!);
		overwrite.tokenSet.access_token = "ownerless-overwrite";
		await expect(persistence.sessions.set(OLD_DID, overwrite)).rejects.toThrow(
			"Ownerless OAuth session creation cannot replace an existing session",
		);
		await expect(session.signOut()).rejects.toThrow(
			"Ownerless OAuth session deletion requires coordinated service logic",
		);
		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(originalSession);

		await persistence.dpopNonces.set(AS_ORIGIN, "replacement-nonce");
		expect(await persistence.dpopNonces.get(AS_ORIGIN)).toBe("replacement-nonce");
	});

	it("serializes concurrent rotating-token refresh through a D1 lease and owner-checked persist", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		server.codeExpiresIn = 0;
		server.refreshDelayMs = 50;
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);

		const first = createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		const second = createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		await Promise.all([first.restore(OLD_DID), second.restore(OLD_DID)]);

		expect(server.refreshCount).toBe(1);
		expect(server.consumedRefreshTokens).toEqual(new Set([`refresh-${OLD_DID}-0`]));
		const stored = await readStoredSession(testEnv.DB, OLD_DID);
		expect(stored?.tokenSet).toMatchObject({
			access_token: `access-${OLD_DID}-1`,
			refresh_token: `refresh-${OLD_DID}-1`,
		});
		const redelivery = await server.fetch(`${AS_ORIGIN}/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				DPoP: "fixture-redelivery",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: `refresh-${OLD_DID}-0`,
			}),
		});
		expect(redelivery.status).toBe(400);
		expect(await redelivery.json()).toEqual({ error: "invalid_grant" });
		const lease = await testEnv.DB.prepare("SELECT owner FROM oauth_session_leases WHERE name = ?")
			.bind(`oauth-session-${OLD_DID}`)
			.first<{ owner: string | null }>();
		expect(lease?.owner).toBeNull();
	});

	it("fails closed without replacing the stored session when its lease expires before persist", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const staleSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(staleSession).toBeDefined();

		const attemptedSession = structuredClone(staleSession!);
		attemptedSession.tokenSet.access_token = "must-not-persist";
		attemptedSession.tokenSet.refresh_token = "must-not-persist";
		const persistence = new D1OAuthPersistence(testEnv.DB);
		const lockName = `oauth-session-${OLD_DID}`;

		await expect(
			persistence.requestLock(lockName, async () => {
				await testEnv.DB.prepare("UPDATE oauth_session_leases SET expires_at = 0 WHERE name = ?")
					.bind(lockName)
					.run();
				await persistence.sessions.set(OLD_DID, attemptedSession);
			}),
		).rejects.toThrow("OAuth session lease was lost before the rotated token was persisted");

		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(staleSession);
	});

	it("does not delete a successor session after delayed invalid_grant from a stale owner", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		server.codeExpiresIn = 0;
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const previousSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(previousSession).toBeDefined();

		server.consumedRefreshTokens.add(`refresh-${OLD_DID}-0`);
		server.refreshDelayMs = 100;
		const staleClient = createConfidentialClient(
			[assertionKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		const staleRestore = staleClient.restore(OLD_DID, { refresh: true });
		const staleRejection = expect(staleRestore).rejects.toThrow(
			"error while deleting stored value",
		);
		await waitFor(() => server.refreshCount === 1);

		const lockName = `oauth-session-${OLD_DID}`;
		await testEnv.DB.prepare("UPDATE oauth_session_leases SET expires_at = 0 WHERE name = ?")
			.bind(lockName)
			.run();
		const successorSession = structuredClone(previousSession!);
		successorSession.tokenSet.access_token = "successor-access";
		successorSession.tokenSet.refresh_token = "successor-refresh";
		successorSession.tokenSet.expires_at = Date.now() + 3_600_000;
		const successorPersistence = new D1OAuthPersistence(testEnv.DB);
		await successorPersistence.requestLock(lockName, async () => {
			await successorPersistence.sessions.set(OLD_DID, successorSession);
		});

		await staleRejection;
		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(successorSession);
	});

	it("keeps overlapping same-instance lease owners operation-local", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const originalSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(originalSession).toBeDefined();

		const persistence = new D1OAuthPersistence(testEnv.DB);
		const lockName = `oauth-session-${OLD_DID}`;
		const ownerAStarted = deferred();
		const resumeOwnerA = deferred();
		let overwriteError: unknown;
		let deleteError: unknown;
		const ownerA = persistence.requestLock(lockName, async () => {
			ownerAStarted.resolve();
			await resumeOwnerA.promise;
			const staleWrite = structuredClone(originalSession!);
			staleWrite.tokenSet.access_token = "stale-owner-access";
			try {
				await persistence.sessions.set(OLD_DID, staleWrite);
			} catch (error) {
				overwriteError = error;
			}
			try {
				await persistence.sessions.delete(OLD_DID);
			} catch (error) {
				deleteError = error;
			}
		});

		await ownerAStarted.promise;
		await testEnv.DB.prepare("UPDATE oauth_session_leases SET expires_at = 0 WHERE name = ?")
			.bind(lockName)
			.run();
		const ownerBSession = structuredClone(originalSession!);
		ownerBSession.tokenSet.access_token = "owner-b-access";
		ownerBSession.tokenSet.refresh_token = "owner-b-refresh";
		await persistence.requestLock(lockName, async () => {
			await persistence.sessions.set(OLD_DID, ownerBSession);
		});

		resumeOwnerA.resolve();
		await ownerA;
		expect(overwriteError).toEqual(
			expect.objectContaining({
				message: "OAuth session lease was lost before the rotated token was persisted",
			}),
		);
		expect(deleteError).toEqual(
			expect.objectContaining({
				message: "OAuth session lease was lost before the stored session was deleted",
			}),
		);
		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(ownerBSession);
	});

	it("renews a long-running owner lease through successor persistence and safe release", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const originalSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(originalSession).toBeDefined();

		const persistence = new D1OAuthPersistence(testEnv.DB, {
			leaseDurationMs: 60,
			leaseRenewIntervalMs: 10,
			leaseAcquireTimeoutMs: 500,
		});
		const lockName = `oauth-session-${OLD_DID}`;
		const successorSession = structuredClone(originalSession!);
		successorSession.tokenSet.access_token = "renewed-owner-access";
		successorSession.tokenSet.refresh_token = "renewed-owner-refresh";
		await persistence.requestLock(lockName, async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
			await persistence.sessions.set(OLD_DID, successorSession);
		});

		expect(persistence.leaseRenewalCount).toBeGreaterThanOrEqual(1);
		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(successorSession);
		const released = await testEnv.DB.prepare(
			"SELECT owner, expires_at FROM oauth_session_leases WHERE name = ?",
		)
			.bind(lockName)
			.first<{ owner: string | null; expires_at: number }>();
		expect(released).toEqual({ owner: null, expires_at: 0 });
	});

	it("marks renewal ownership loss and keeps later persistence fail-closed", async () => {
		const assertionKey = await generateClientAssertionKey("assertion-old");
		const server = new OAuthServerFixture();
		await authorizeAndCallback(testEnv.DB, [assertionKey], server);
		const originalSession = await readStoredSession(testEnv.DB, OLD_DID);
		expect(originalSession).toBeDefined();

		const persistence = new D1OAuthPersistence(testEnv.DB, {
			leaseDurationMs: 100,
			leaseRenewIntervalMs: 10,
			leaseAcquireTimeoutMs: 500,
		});
		const lockName = `oauth-session-${OLD_DID}`;
		const ownerStarted = deferred();
		const ownershipStolen = deferred();
		let persistenceError: unknown;
		const operation = persistence.requestLock(lockName, async () => {
			ownerStarted.resolve();
			await ownershipStolen.promise;
			await waitFor(() => persistence.leaseRenewalLossCount === 1);
			try {
				await persistence.sessions.set(OLD_DID, structuredClone(originalSession!));
			} catch (error) {
				persistenceError = error;
			}
		});

		await ownerStarted.promise;
		await testEnv.DB.prepare(
			"UPDATE oauth_session_leases SET owner = ?, expires_at = ? WHERE name = ?",
		)
			.bind("successor-owner", Date.now() + 1_000, lockName)
			.run();
		ownershipStolen.resolve();
		await operation;

		expect(persistenceError).toEqual(
			expect.objectContaining({ message: "OAuth session lease renewal lost ownership" }),
		);
		expect(await readStoredSession(testEnv.DB, OLD_DID)).toEqual(originalSession);
	});

	it("pins originating assertion kids across rotation without treating JWKS removal as token revocation", async () => {
		const oldKey = await generateClientAssertionKey("assertion-old");
		const newKey = await generateClientAssertionKey("assertion-new");
		const server = new OAuthServerFixture();
		const { session: existingSession } = await authorizeAndCallback(testEnv.DB, [oldKey], server);

		const rotatingClient = createConfidentialClient(
			[newKey, oldKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		await rotatingClient.restore(OLD_DID, { refresh: false });
		const { stateId } = await rotatingClient.authorize({
			target: { type: "pds", serviceUrl: "https://pds.emdashcms.com" },
		});
		expect((await readStoredSession(testEnv.DB, OLD_DID))?.authMethod).toEqual({
			method: "private_key_jwt",
			kid: "assertion-old",
		});
		expect((await readStoredState(testEnv.DB, stateId))?.authMethod).toEqual({
			method: "private_key_jwt",
			kid: "assertion-new",
		});

		const newSession = await rotatingClient.callback(
			new URLSearchParams({ state: stateId, code: "new-code", iss: AS_ORIGIN }),
		);
		expect(newSession.session.did).toBe(NEW_DID);
		expect((await readStoredSession(testEnv.DB, NEW_DID))?.authMethod).toEqual({
			method: "private_key_jwt",
			kid: "assertion-new",
		});

		const newOnlyClient = createConfidentialClient(
			[newKey],
			new D1OAuthPersistence(testEnv.DB),
			server,
		);
		expect(newOnlyClient.jwks?.keys.map((key) => key.kid)).toEqual(["assertion-new"]);
		const tokenRequestCount = server.tokenRequests.length;
		const response = await existingSession.handle(
			"/xrpc/com.atproto.repo.createRecord?repo=test&collection=com.emdashcms.experimental.package.release",
			{ method: "POST", body: "{}" },
		);
		expect(response.ok).toBe(true);
		expect(server.tokenRequests).toHaveLength(tokenRequestCount);
		expect(server.resourceRequests).toHaveLength(1);

		await expect(newOnlyClient.restore(OLD_DID, { refresh: false })).rejects.toThrow(
			'key "assertion-old" no longer available or compatible',
		);
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for OAuth fixture event");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
