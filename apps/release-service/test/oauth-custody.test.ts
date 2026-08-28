import type { ActorResolver } from "@atcute/identity-resolver";
import type { StoredSession, StoredState } from "@atcute/oauth-node-client";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { base64url } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import {
	OAuthCustodyError,
	canonicalizeRedirectTarget,
	createPublisherOAuthClient,
	createPublisherOAuthStores,
} from "../src/oauth/custody.js";
import { ASSERTION_KEY_1, ASSERTION_KEY_2, TEST_BINDINGS } from "./fixtures/oauth.js";

const DID = "did:plc:publisher" as const;
const OTHER_DID = "did:plc:other" as const;
const RAW_STATE = "abcdefghijklmnopqrstuvwx";
const PKCE_VERIFIER = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const DPOP_KEY = {
	kty: "EC",
	crv: "P-256",
	alg: "ES256",
	x: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
	y: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
	d: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
} as const satisfies StoredSession["dpopKey"];

function state(userState: unknown, overrides: Partial<StoredState> = {}): StoredState {
	return {
		dpopKey: DPOP_KEY,
		authMethod: { method: "private_key_jwt", kid: ASSERTION_KEY_2.kid },
		pkceVerifier: PKCE_VERIFIER,
		issuer: "https://authorization.example",
		redirectUri: "https://release.example.com/oauth/callback",
		sub: DID,
		userState,
		expiresAt: Date.now() + 10 * 60_000,
		...overrides,
	};
}

function session(scope: string, overrides: Partial<StoredSession["tokenSet"]> = {}): StoredSession {
	return {
		dpopKey: DPOP_KEY,
		authMethod: { method: "private_key_jwt", kid: ASSERTION_KEY_2.kid },
		tokenSet: {
			iss: "https://authorization.example",
			sub: DID,
			aud: "https://pds.example",
			scope: scope as StoredSession["tokenSet"]["scope"],
			access_token: "access-token-secret",
			refresh_token: "refresh-token-secret",
			token_type: "DPoP",
			expires_at: Date.now() + 60_000,
			...overrides,
		},
	};
}

afterEach(async () => {
	await reset();
});

describe("Durable Object OAuth custody", () => {
	it("encrypts state, consumes it once, and never persists raw state or PKCE", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const custody = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation?complete=1",
			},
		);
		await custody.stores.states.set(RAW_STATE, state(custody.userState));
		const stateHash = base64url.encode(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RAW_STATE))),
		);

		const persisted = await runInDurableObject(
			env.OAUTH_STATE_DO.getByName(stateHash),
			(_instance, durableState) =>
				durableState.storage.sql
					.exec<{
						state_hash: string;
						encrypted_state: string;
						encryption_key_version: number;
					}>("SELECT state_hash, encrypted_state, encryption_key_version FROM oauth_state")
					.one(),
		);
		expect(persisted.state_hash).toBe(stateHash);
		expect(persisted.encryption_key_version).toBe(configuration.encryption.currentKeyVersion);
		expect(JSON.stringify(persisted)).not.toContain(RAW_STATE);
		expect(JSON.stringify(persisted)).not.toContain(PKCE_VERIFIER);
		await expect(custody.stores.states.get(RAW_STATE)).resolves.toMatchObject({
			sub: DID,
			pkceVerifier: PKCE_VERIFIER,
			userState: custody.userState,
		});
		await expect(custody.stores.states.get(RAW_STATE)).resolves.toBeUndefined();
	});

	it("fails closed for state identity, redirect, key, and user-state mismatches", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const custody = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
			},
		);
		const cases: StoredState[] = [
			state(custody.userState, { sub: OTHER_DID }),
			state(custody.userState, { redirectUri: "https://other.example/callback" }),
			state(custody.userState, {
				authMethod: { method: "private_key_jwt", kid: "retired-key" },
			}),
			state({ ...custody.userState, redirectTarget: "//evil.example" }),
		];
		for (const [index, value] of cases.entries()) {
			await expect(custody.stores.states.set(`${RAW_STATE}${index}`, value)).rejects.toBeInstanceOf(
				OAuthCustodyError,
			);
		}
	});

	it("keeps identity-only sessions in request-local memory", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const flow = {
			purpose: "publisher_identity",
			expectedDid: DID,
			redirectTarget: "/publisher",
		} as const;
		const first = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			flow,
		);
		const identitySession = session("atproto", { refresh_token: undefined });
		await first.stores.sessions.set(DID, identitySession);
		await expect(first.stores.sessions.get(DID)).resolves.toEqual(identitySession);
		const second = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			flow,
		);
		await expect(second.stores.sessions.get(DID)).resolves.toBeUndefined();
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toBeNull();
	});

	it("persists only exact-scope encrypted delegations and rejects replacement", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const custody = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
			},
		);
		const delegatedSession = session(configuration.oauth.releaseScope);
		await custody.stores.sessions.set(DID, delegatedSession);
		await expect(custody.stores.sessions.get(DID)).resolves.toEqual(delegatedSession);
		expect(custody.sessionVersion?.(DID)).toBe(1);
		await expect(custody.stores.sessions.set(DID, delegatedSession)).rejects.toMatchObject({
			code: "OAUTH_DELEGATION_CAS_REQUIRED",
		});
		await expect(custody.stores.sessions.set(DID, session("atproto"))).rejects.toMatchObject({
			code: "OAUTH_SCOPE_INVALID",
		});

		const persisted = await runInDurableObject(
			env.PUBLISHER_DO.getByName(DID),
			(_instance, durableState) =>
				durableState.storage.sql
					.exec<{ encrypted_session: string; scope: string }>(
						"SELECT encrypted_session, scope FROM delegation WHERE id = 1",
					)
					.one(),
		);
		expect(persisted.scope).toBe(configuration.oauth.releaseScope);
		expect(persisted.encrypted_session).not.toContain("access-token-secret");
		expect(persisted.encrypted_session).not.toContain("refresh-token-secret");
	});

	it("stores refresh results only through the active generation-bound lease", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const custody = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
			},
		);
		await custody.stores.sessions.set(DID, session(configuration.oauth.releaseScope));
		expect(custody.requestLock).toBeTypeOf("function");
		await custody.requestLock?.(`oauth-session-${DID}`, async () => {
			await expect(custody.stores.sessions.get(DID)).resolves.toBeDefined();
			await custody.stores.sessions.set(
				DID,
				session(configuration.oauth.releaseScope, {
					access_token: "refreshed-access-secret",
					refresh_token: "refreshed-refresh-secret",
					expires_at: Date.now() + 120_000,
				}),
			);
		});

		await expect(custody.stores.sessions.get(DID)).resolves.toMatchObject({
			tokenSet: {
				access_token: "refreshed-access-secret",
				refresh_token: "refreshed-refresh-secret",
			},
		});
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			stateVersion: 2,
		});
		expect(custody.sessionVersion?.(DID)).toBe(2);
	});

	it("revokes authority and rejects assertion-key reuse as DPoP", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const custody = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			{
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
			},
		);
		const reusedKey = {
			...DPOP_KEY,
			x: ASSERTION_KEY_1.x,
			y: ASSERTION_KEY_1.y,
			d: ASSERTION_KEY_1.d,
		};
		await expect(
			custody.stores.sessions.set(DID, {
				...session(configuration.oauth.releaseScope),
				dpopKey: reusedKey,
			}),
		).rejects.toMatchObject({ code: "OAUTH_SESSION_INVALID" });

		await custody.stores.sessions.set(DID, session(configuration.oauth.releaseScope));
		await custody.stores.sessions.delete(DID);
		await expect(custody.stores.sessions.get(DID)).resolves.toBeUndefined();
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			status: "revoked",
			encryptedSession: "",
		});
	});

	it("allows explicit revocation after a failed restore marks reauthorization required", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const flow = {
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/publisher/delegation",
		} as const;
		const initial = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			configuration.encryption,
			configuration.oauth,
			flow,
		);
		await initial.stores.sessions.set(DID, session(configuration.oauth.releaseScope));
		const beforeRetirement = await env.PUBLISHER_DO.getByName(DID).getDelegation(DID);

		const rotatedConfiguration = await loadConfiguration({
			...TEST_BINDINGS,
			OAUTH_ASSERTION_KEYSET: JSON.stringify({
				active: ASSERTION_KEY_1.kid,
				keys: [ASSERTION_KEY_1],
			}),
		});
		const afterRetirement = createPublisherOAuthStores(
			env.PUBLISHER_DO,
			rotatedConfiguration.encryption,
			rotatedConfiguration.oauth,
			flow,
		);
		await expect(afterRetirement.stores.sessions.get(DID)).rejects.toMatchObject({
			code: "OAUTH_CLIENT_KEY_UNAVAILABLE",
		});
		await afterRetirement.stores.sessions.delete(DID);
		const afterRetirementDelegation = await env.PUBLISHER_DO.getByName(DID).getDelegation(DID);
		expect(beforeRetirement?.encryptedSession).not.toBe("");
		expect(afterRetirementDelegation).toMatchObject({
			status: "revoked",
			stateVersion: 3,
			encryptedSession: "",
		});
	});

	it("builds a confidential client around the Durable Object stores", async () => {
		const configuration = await loadConfiguration({
			...TEST_BINDINGS,
			PUBLIC_ORIGIN: "https://release.example.com",
			OAUTH_REDIRECT_URIS: '["https://release.example.com/oauth/callback"]',
		});
		const result = createPublisherOAuthClient({
			namespace: env.PUBLISHER_DO,
			encryption: configuration.encryption,
			oauth: configuration.oauth,
			flow: {
				purpose: "release_delegation",
				expectedDid: DID,
				redirectTarget: "/publisher/delegation",
			},
		});
		expect(result.metadata).toMatchObject({
			client_id: configuration.oauth.clientMetadata.client_id,
			scope: configuration.oauth.releaseScope,
			token_endpoint_auth_method: "private_key_jwt",
		});
		expect(result.jwks?.keys).toHaveLength(2);
		expect(result.userState).toEqual({
			purpose: "release_delegation",
			expectedDid: DID,
			redirectTarget: "/publisher/delegation",
		});
	});

	it.each([
		["publisher_identity", "atproto"],
		[
			"release_delegation",
			"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		],
	] as const)("forces the %s authorization scope", async (purpose, expectedScope) => {
		const configuration = await loadConfiguration({
			...TEST_BINDINGS,
			PUBLIC_ORIGIN: "https://release.example.com",
			OAUTH_REDIRECT_URIS: '["https://release.example.com/oauth/callback"]',
		});
		const requests: Array<{ url: string; body: URLSearchParams }> = [];
		const fetchMock: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.pathname === "/.well-known/oauth-protected-resource") {
				return Response.json({
					resource: "https://pds.example",
					authorization_servers: ["https://authorization.example"],
				});
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: "https://authorization.example",
					authorization_endpoint: "https://authorization.example/authorize",
					token_endpoint: "https://authorization.example/token",
					pushed_authorization_request_endpoint: "https://authorization.example/par",
					client_id_metadata_document_supported: true,
					dpop_signing_alg_values_supported: ["ES256"],
					response_types_supported: ["code"],
				});
			}
			if (url.pathname === "/par") {
				const body = new URLSearchParams();
				if (input instanceof Request) {
					for (const [key, value] of await input.clone().formData()) {
						if (typeof value === "string") body.append(key, value);
					}
				} else {
					const rawBody = init?.body;
					if (typeof rawBody !== "string" && !(rawBody instanceof URLSearchParams)) {
						throw new Error("Expected a form-encoded OAuth request body");
					}
					for (const [key, value] of new URLSearchParams(rawBody)) {
						body.append(key, value);
					}
				}
				requests.push({ url: url.toString(), body });
				return Response.json({
					request_uri: "urn:ietf:params:oauth:request_uri:test",
					expires_in: 60,
				});
			}
			throw new Error(`Unexpected OAuth request: ${url.toString()}`);
		};
		const actorResolver = {
			async resolve() {
				return { did: DID, handle: "publisher.example.com", pds: "https://pds.example" };
			},
		} satisfies ActorResolver;
		const client = createPublisherOAuthClient({
			namespace: env.PUBLISHER_DO,
			encryption: configuration.encryption,
			oauth: configuration.oauth,
			flow: { purpose, expectedDid: DID, redirectTarget: "/publisher" },
			actorResolver,
			fetch: fetchMock,
		});

		const authorization = await client.authorize({ type: "account", identifier: DID });
		expect(authorization.url.origin).toBe("https://authorization.example");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.body.get("scope")).toBe(expectedScope);
		expect(requests[0]?.body.get("scope")).not.toContain("transition:generic");
		expect(requests[0]?.body.get("redirect_uri")).toBe(
			"https://release.example.com/oauth/callback",
		);
	});
});

describe("OAuth redirect targets", () => {
	it.each(["https://evil.example", "//evil.example", "/\\evil", "/path\nnext"])(
		"rejects %j",
		(value) => {
			expect(() => canonicalizeRedirectTarget(value, "https://release.example.com")).toThrowError(
				expect.objectContaining({ code: "OAUTH_REDIRECT_INVALID" }),
			);
		},
	);

	it("normalizes a same-origin path", () => {
		expect(
			canonicalizeRedirectTarget(
				"/publisher/../publisher?done=1#result",
				"https://release.example.com",
			),
		).toBe("/publisher?done=1#result");
	});
});
