import type { ActorResolver } from "@atcute/identity-resolver";
import {
	OAuthClient,
	type ClientAssertionPrivateJwk,
	type StoredSession,
	type StoredState,
} from "@atcute/oauth-node-client";

import { D1OAuthPersistence } from "./d1-persistence.js";

export const RELEASE_SCOPE =
	"atproto repo:com.emdashcms.experimental.package.release?action=create";
export const CLIENT_ID = "https://release.emdashcms.com/oauth/client-metadata.json";
export const JWKS_URI = "https://release.emdashcms.com/oauth/jwks.json";
export const REDIRECT_URI = "https://release.emdashcms.com/oauth/callback";
export const PDS_ORIGIN = "https://pds.emdashcms.com";
export const AS_ORIGIN = "https://auth.emdashcms.com";
export const OLD_DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
export const NEW_DID = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

interface CapturedRequest {
	url: string;
	body: URLSearchParams;
	dpop: string;
}

export class OAuthServerFixture {
	readonly parRequests: CapturedRequest[] = [];
	readonly tokenRequests: CapturedRequest[] = [];
	readonly resourceRequests: Request[] = [];
	readonly consumedRefreshTokens = new Set<string>();
	refreshCount = 0;
	refreshDelayMs = 0;
	codeExpiresIn = 3_600;

	readonly fetch: typeof globalThis.fetch = async (input, init) => {
		const request =
			input instanceof Request && init === undefined ? input : new Request(input, init);
		const url = new URL(request.url);

		if (url.href === `${PDS_ORIGIN}/.well-known/oauth-protected-resource`) {
			return jsonResponse({ resource: PDS_ORIGIN, authorization_servers: [AS_ORIGIN] });
		}
		if (url.href === `${AS_ORIGIN}/.well-known/oauth-authorization-server`) {
			return jsonResponse({
				issuer: AS_ORIGIN,
				authorization_endpoint: `${AS_ORIGIN}/authorize`,
				token_endpoint: `${AS_ORIGIN}/token`,
				pushed_authorization_request_endpoint: `${AS_ORIGIN}/par`,
				token_endpoint_auth_methods_supported: ["private_key_jwt"],
				token_endpoint_auth_signing_alg_values_supported: ["ES256"],
				dpop_signing_alg_values_supported: ["ES256"],
				client_id_metadata_document_supported: true,
				protected_resources: [PDS_ORIGIN],
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
			});
		}

		if (url.href === `${AS_ORIGIN}/par`) {
			const captured = await captureRequest(request);
			this.parRequests.push(captured);
			if (this.parRequests.length === 1) {
				return jsonResponse(
					{ error: "use_dpop_nonce" },
					{ status: 400, headers: { "DPoP-Nonce": "par-nonce" } },
				);
			}
			return jsonResponse({
				request_uri: "urn:ietf:params:oauth:request_uri:test",
				expires_in: 60,
			});
		}

		if (url.href === `${AS_ORIGIN}/token`) {
			const captured = await captureRequest(request);
			this.tokenRequests.push(captured);
			const grantType = captured.body.get("grant_type");
			if (grantType === "authorization_code") {
				const sub = captured.body.get("code") === "new-code" ? NEW_DID : OLD_DID;
				return jsonResponse({
					access_token: `access-${sub}`,
					refresh_token: `refresh-${sub}-0`,
					token_type: "DPoP",
					sub,
					scope: RELEASE_SCOPE,
					expires_in: this.codeExpiresIn,
				});
			}
			if (grantType === "refresh_token") {
				this.refreshCount++;
				const refreshToken = captured.body.get("refresh_token");
				if (
					refreshToken !== `refresh-${OLD_DID}-0` ||
					this.consumedRefreshTokens.has(refreshToken)
				) {
					await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
					return jsonResponse({ error: "invalid_grant" }, { status: 400 });
				}
				this.consumedRefreshTokens.add(refreshToken);
				await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
				return jsonResponse({
					access_token: `access-${OLD_DID}-1`,
					refresh_token: `refresh-${OLD_DID}-1`,
					token_type: "DPoP",
					sub: OLD_DID,
					scope: RELEASE_SCOPE,
					expires_in: 3_600,
				});
			}
		}

		if (url.origin === PDS_ORIGIN) {
			this.resourceRequests.push(request);
			return jsonResponse({
				uri: `at://${OLD_DID}/com.emdashcms.experimental.package.release/demo:1.0.0`,
			});
		}

		return new Response("not found", { status: 404 });
	};
}

const actorResolver: ActorResolver = {
	async resolve(actor) {
		return {
			did: actor as typeof OLD_DID,
			handle: "publisher.emdashcms.com",
			pds: PDS_ORIGIN,
		};
	},
};

export function createConfidentialClient(
	keys: ClientAssertionPrivateJwk[],
	persistence: D1OAuthPersistence,
	server: OAuthServerFixture,
): OAuthClient {
	return new OAuthClient({
		metadata: {
			client_id: CLIENT_ID,
			redirect_uris: [REDIRECT_URI],
			scope: RELEASE_SCOPE,
			jwks_uri: JWKS_URI,
		},
		keyset: keys,
		actorResolver,
		stores: {
			sessions: persistence.sessions,
			states: persistence.states,
			dpopNonces: persistence.dpopNonces,
		},
		requestLock: persistence.requestLock,
		fetch: server.fetch,
	});
}

export async function authorizeAndCallback(
	db: D1Database,
	keys: ClientAssertionPrivateJwk[],
	server: OAuthServerFixture,
	code = "old-code",
): Promise<{
	client: OAuthClient;
	session: Awaited<ReturnType<OAuthClient["restore"]>>;
	stateId: string;
}> {
	const authorizingClient = createConfidentialClient(keys, new D1OAuthPersistence(db), server);
	const { stateId } = await authorizingClient.authorize({
		target: { type: "pds", serviceUrl: PDS_ORIGIN },
	});

	const callbackClient = createConfidentialClient(keys, new D1OAuthPersistence(db), server);
	const { session } = await callbackClient.callback(
		new URLSearchParams({ state: stateId, code, iss: AS_ORIGIN }),
	);
	return { client: callbackClient, session, stateId };
}

export async function readStoredState(
	db: D1Database,
	stateId: string,
): Promise<StoredState | undefined> {
	return new D1OAuthPersistence(db).states.get(stateId);
}

export async function readStoredSession(
	db: D1Database,
	did: string,
): Promise<StoredSession | undefined> {
	return new D1OAuthPersistence(db).sessions.get(did);
}

export function decodeJwtPart(value: string, index: 0 | 1): Record<string, unknown> {
	const encoded = value.split(".")[index];
	if (!encoded) throw new Error("Invalid JWT fixture value");
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.fromBase64(encoded, { alphabet: "base64url" })),
	) as Record<string, unknown>;
}

async function captureRequest(request: Request): Promise<CapturedRequest> {
	return {
		url: request.url,
		body: new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer())),
		dpop: requiredHeader(request.headers, "DPoP"),
	};
}

function requiredHeader(headers: Headers, name: string): string {
	const value = headers.get(name);
	if (!value) throw new Error(`Missing ${name} header`);
	return value;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(body), { ...init, headers });
}
