import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	SignJWT,
	type JWTPayload,
	type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { MicrosoftOAuthConfig } from "../types.js";
import { createMicrosoftProvider, isValidMicrosoftTenant } from "./microsoft.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_TENANT = "f8cdef31-a31e-4b4a-93e4-5f571e91255a";
const CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad";
const CLIENT_ID = "6731de76-14a6-49ae-97bc-6eba6914391e";
const NONCE = "nonce-123";

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
let foreignKey: CryptoKey;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	const jwk = await exportJWK(pair.publicKey);
	keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
	foreignKey = (await generateKeyPair("RS256")).privateKey;
});

function issuer(tid: string): string {
	return `https://login.microsoftonline.com/${tid}/v2.0`;
}

function claims(overrides: JWTPayload = {}): JWTPayload {
	return {
		sub: "subject-1",
		iss: issuer(TENANT),
		tid: TENANT,
		nonce: NONCE,
		email: "ada@contoso.com",
		preferred_username: "ada@contoso.com",
		name: "Ada",
		...overrides,
	};
}

async function sign(
	payload: JWTPayload,
	options: { key?: CryptoKey; audience?: string; expiresIn?: string | number } = {},
): Promise<string> {
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "RS256", kid: "test" })
		.setAudience(options.audience ?? CLIENT_ID)
		.setIssuedAt()
		.setExpirationTime(options.expiresIn ?? "5m")
		.sign(options.key ?? privateKey);
}

function provider(config: Partial<MicrosoftOAuthConfig> = {}) {
	return createMicrosoftProvider(
		{ clientId: CLIENT_ID, clientSecret: "secret", tenant: TENANT, ...config },
		keys,
	);
}

async function profileFor(token: string, config: Partial<MicrosoftOAuthConfig> = {}) {
	const p = provider(config);
	if (!p.verifyIdToken) throw new Error("expected ID token verification");
	return p.parseProfile(await p.verifyIdToken(token, NONCE));
}

describe("Microsoft provider", () => {
	it("builds the endpoints for the configured tenant", () => {
		const p = provider();
		expect(p.authorizeUrl).toBe(
			`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
		);
		expect(p.tokenUrl).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
	});

	it("rejects a tenant given as a domain name", () => {
		expect(isValidMicrosoftTenant("contoso.onmicrosoft.com")).toBe(false);
		expect(() => provider({ tenant: "contoso.onmicrosoft.com" })).toThrow();
	});

	it("counts a member's address as verified in a configured tenant", async () => {
		const profile = await profileFor(await sign(claims()));
		expect(profile).toEqual({
			id: "subject-1",
			email: "ada@contoso.com",
			name: "Ada",
			avatarUrl: null,
			emailVerified: true,
		});
	});

	it("treats an idp equal to the issuer as a member", async () => {
		const profile = await profileFor(await sign(claims({ idp: issuer(TENANT) })));
		expect(profile.emailVerified).toBe(true);
	});

	it("does not count a guest's address as verified", async () => {
		const profile = await profileFor(await sign(claims({ idp: issuer(OTHER_TENANT) })));
		expect(profile.emailVerified).toBe(false);
	});

	it("does not count an email outside the sign-in name's domain as verified", async () => {
		const token = await sign(claims({ email: "ceo@fabrikam.com" }));
		expect((await profileFor(token)).emailVerified).toBe(false);
	});

	it("counts an email in the sign-in name's domain as verified", async () => {
		const token = await sign(
			claims({ email: "ada.lovelace@contoso.com", preferred_username: "ada@Contoso.com" }),
		);
		expect((await profileFor(token)).emailVerified).toBe(true);
	});

	it("counts an email in another domain as verified when xms_edov confirms it", async () => {
		const token = await sign(claims({ email: "ada@fabrikam.com", xms_edov: true }));
		expect((await profileFor(token)).emailVerified).toBe(true);
	});

	it("accepts xms_edov as a string or number", async () => {
		for (const xms_edov of ["true", 1, "1"]) {
			const token = await sign(claims({ email: "ada@fabrikam.com", xms_edov }));
			expect((await profileFor(token)).emailVerified).toBe(true);
		}
	});

	it("does not count an email in another domain as verified when xms_edov is false", async () => {
		for (const xms_edov of [false, "false", 0, "0"]) {
			const token = await sign(claims({ email: "ada@fabrikam.com", xms_edov }));
			expect((await profileFor(token)).emailVerified).toBe(false);
		}
	});

	it("does not count addresses as verified through a multi-tenant segment", async () => {
		const token = await sign(claims());
		for (const tenant of ["common", "organizations"]) {
			expect((await profileFor(token, { tenant })).emailVerified).toBe(false);
		}
	});

	it("does not count personal accounts as verified when consumers is given by its ID", async () => {
		const personal = await sign(claims({ tid: CONSUMERS, iss: issuer(CONSUMERS) }));
		expect((await profileFor(personal, { tenant: CONSUMERS })).emailVerified).toBe(false);
	});

	it("applies the emailVerified option either way", async () => {
		const guest = await sign(claims({ idp: issuer(OTHER_TENANT) }));
		expect((await profileFor(guest, { emailVerified: true })).emailVerified).toBe(true);
		const member = await sign(claims());
		expect((await profileFor(member, { emailVerified: false })).emailVerified).toBe(false);
	});

	it("falls back to preferred_username for the address and counts it as verified", async () => {
		const token = await sign(claims({ email: undefined, preferred_username: "ada@contoso.com" }));
		const profile = await profileFor(token);
		expect(profile.email).toBe("ada@contoso.com");
		expect(profile.emailVerified).toBe(true);
	});

	it("rejects a token without an email address", async () => {
		const token = await sign(claims({ email: undefined, preferred_username: "ada" }));
		await expect(profileFor(token)).rejects.toThrow("no email address");
	});

	it("rejects a token from another tenant", async () => {
		const token = await sign(claims({ tid: OTHER_TENANT, iss: issuer(OTHER_TENANT) }));
		await expect(profileFor(token)).rejects.toThrow("different tenant");
	});

	it("rejects an issuer that does not match the token's tenant", async () => {
		const token = await sign(claims({ iss: issuer(OTHER_TENANT) }));
		await expect(profileFor(token, { tenant: "common" })).rejects.toThrow("issuer");
	});

	it("rejects personal accounts through organizations and requires them through consumers", async () => {
		const personal = await sign(claims({ tid: CONSUMERS, iss: issuer(CONSUMERS) }));
		await expect(profileFor(personal, { tenant: "organizations" })).rejects.toThrow(
			"Personal Microsoft accounts",
		);
		await expect(profileFor(personal, { tenant: "consumers" })).resolves.toBeDefined();
		await expect(profileFor(await sign(claims()), { tenant: "consumers" })).rejects.toThrow(
			"different tenant",
		);
	});

	it("rejects a token for another client", async () => {
		const token = await sign(claims(), { audience: "another-client" });
		await expect(profileFor(token)).rejects.toThrow('"aud"');
	});

	it("rejects a token whose nonce does not match", async () => {
		const token = await sign(claims({ nonce: "other-nonce" }));
		await expect(profileFor(token)).rejects.toThrow("nonce");
	});

	it("rejects an expired token", async () => {
		const token = await sign(claims(), { expiresIn: Math.floor(Date.now() / 1000) - 60 });
		await expect(profileFor(token)).rejects.toThrow('"exp"');
	});

	it("rejects a token without an expiry", async () => {
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.sign(privateKey);
		await expect(profileFor(token)).rejects.toThrow('"exp"');
	});

	it("rejects a token signed with another key", async () => {
		const token = await sign(claims(), { key: foreignKey });
		await expect(profileFor(token)).rejects.toThrow("signature verification failed");
	});

	it("rejects a token signed with another algorithm", async () => {
		const pss = await generateKeyPair("PS256");
		// Microsoft's published keys carry no `alg`, so the key set alone does
		// not restrict the algorithm.
		const pssKeys = createLocalJWKSet({
			keys: [{ ...(await exportJWK(pss.publicKey)), kid: "pss" }],
		});
		const token = await new SignJWT(claims())
			.setProtectedHeader({ alg: "PS256", kid: "pss" })
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(pss.privateKey);
		const p = createMicrosoftProvider(
			{ clientId: CLIENT_ID, clientSecret: "secret", tenant: TENANT },
			pssKeys,
		);
		await expect(p.verifyIdToken?.(token, NONCE)).rejects.toThrow('"alg"');
	});
});
