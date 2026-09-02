import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resumeSession, revokeSession } from "../src/oauth.js";

const DID = "did:plc:publisher" as const;

function storedSession() {
	return {
		dpopKey: {
			kty: "EC",
			crv: "P-256",
			alg: "ES256",
			x: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
			y: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8",
			d: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
		},
		authMethod: { method: "none" },
		tokenSet: {
			iss: "https://authorization.example",
			sub: DID,
			aud: "https://pds.example",
			scope: "atproto",
			access_token: "access-token",
			refresh_token: "refresh-token",
			token_type: "DPoP",
			expires_at: 1,
		},
	};
}

async function writeSession(stateDir: string): Promise<void> {
	await writeFile(
		join(stateDir, "sessions.json"),
		`${JSON.stringify({ version: 1, entries: { [DID]: storedSession() } }, null, 2)}\n`,
		{ mode: 0o600 },
	);
}

async function writeRegistration(stateDir: string): Promise<void> {
	await writeFile(
		join(stateDir, "clients.json"),
		`${JSON.stringify(
			{
				version: 1,
				entries: {
					[DID]: {
						redirectUri: "http://127.0.0.1:12345/callback",
						scope: "atproto",
					},
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

function authorizationMetadata(): Response {
	return Response.json({
		issuer: "https://authorization.example",
		authorization_endpoint: "https://authorization.example/authorize",
		token_endpoint: "https://authorization.example/token",
		revocation_endpoint: "https://authorization.example/revoke",
		pushed_authorization_request_endpoint: "https://authorization.example/par",
		client_id_metadata_document_supported: true,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"],
		dpop_signing_alg_values_supported: ["ES256"],
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("stored OAuth client registration", () => {
	it("resumes a stored session with its original loopback registration", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-ok-"));
		try {
			await writeSession(stateDir);
			await writeRegistration(stateDir);
			vi.stubGlobal(
				"fetch",
				vi.fn(() => Promise.resolve(authorizationMetadata())),
			);

			const session = await resumeSession(DID, { stateDir, scope: "atproto", refresh: false });

			expect(session.sub).toBe(DID);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("reaches server revocation when the original loopback registration is present", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-revoke-"));
		try {
			await writeSession(stateDir);
			await writeRegistration(stateDir);
			const fetchMock = vi.fn((input: string | URL | Request) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				return url.pathname === "/.well-known/oauth-authorization-server"
					? Promise.resolve(authorizationMetadata())
					: Promise.resolve(new Response(null, { status: 200 }));
			});
			vi.stubGlobal("fetch", fetchMock);

			await expect(revokeSession(DID, { stateDir, strict: true })).resolves.toEqual({
				serverRevoked: true,
			});
			expect(JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"))).toEqual({
				version: 1,
				entries: {},
			});
			expect(JSON.parse(await readFile(join(stateDir, "clients.json"), "utf8"))).toEqual({
				version: 1,
				entries: {},
			});
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("fails before refresh and preserves the session when registration metadata is missing", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-"));
		try {
			await writeSession(stateDir);
			vi.stubGlobal(
				"fetch",
				vi.fn(() => {
					throw new Error("refresh must not run without the original client registration");
				}),
			);

			await expect(resumeSession(DID, { stateDir, scope: "atproto" })).rejects.toThrow(
				"Stored OAuth client registration is missing or invalid; sign in again",
			);
			expect(JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"))).toMatchObject({
				entries: { [DID]: { tokenSet: { refresh_token: "refresh-token" } } },
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("preserves the session when strict server revocation lacks registration metadata", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "emdash-oauth-registration-"));
		try {
			await writeSession(stateDir);
			await expect(revokeSession(DID, { stateDir, strict: true })).rejects.toThrow(
				"Stored OAuth client registration is missing or invalid; sign in again",
			);
			expect(JSON.parse(await readFile(join(stateDir, "sessions.json"), "utf8"))).toHaveProperty(
				`entries.${DID}`,
			);
		} finally {
			await rm(stateDir, { recursive: true, force: true });
		}
	});
});
