import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
	AccessAuthError,
	getAccessKeyResolver,
	hasRole,
	parseAccessAuthConfig,
	verifyAccessRequest,
} from "../src/access-auth.js";
import type { AccessAuthConfig, AccessKeyResolver, OperatorIdentity } from "../src/access-auth.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";

function baseConfig(overrides: Partial<AccessAuthConfig> = {}): AccessAuthConfig {
	return {
		teamDomain: TEAM_DOMAIN,
		audience: AUDIENCE,
		admins: ["admin@example.com", "emdash-labeler-admins"],
		reviewers: ["reviewer@example.com", "emdash-labeler-reviewers"],
		...overrides,
	};
}

interface MintOverrides {
	sub?: string;
	email?: string;
	common_name?: string;
	groups?: unknown;
	issuer?: string;
	audience?: string;
	expiresInSeconds?: number;
	notBeforeInSeconds?: number;
}

async function mintToken(overrides: MintOverrides, signKey: CryptoKey): Promise<string> {
	const {
		issuer = TEAM_DOMAIN,
		audience = AUDIENCE,
		expiresInSeconds = 3600,
		notBeforeInSeconds,
		...claims
	} = overrides;
	const now = Math.floor(Date.now() / 1000);
	let jwt = new SignJWT({ sub: "user-sub-1", ...claims })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(issuer)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(now + expiresInSeconds);
	if (notBeforeInSeconds !== undefined) jwt = jwt.setNotBefore(now + notBeforeInSeconds);
	return jwt.sign(signKey);
}

function requestWith(headers: Record<string, string>): Request {
	return new Request("https://labeler.example.com/admin", { headers });
}

let signKey: CryptoKey;
let otherKey: CryptoKey;
let resolver: AccessKeyResolver;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	// Local resolver mimicking jose's remote-JWKS signature: (protectedHeader, token) => key.
	resolver = (async () => pair.publicKey) as AccessKeyResolver;

	const otherPair = await generateKeyPair("RS256");
	otherKey = otherPair.privateKey;
});

describe("verifyAccessRequest", () => {
	it("accepts a valid human token and maps roles from the email allowlist", async () => {
		const token = await mintToken({ email: "admin@example.com" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity).toEqual<OperatorIdentity>({
			kind: "human",
			email: "admin@example.com",
			sub: "user-sub-1",
			roles: ["admin"],
		});
	});

	it("accepts a valid service token identified by common_name", async () => {
		const token = await mintToken({ common_name: "ci-automation" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig({ admins: ["ci-automation"] }),
			resolver,
		);
		expect(identity).toEqual<OperatorIdentity>({
			kind: "service",
			commonName: "ci-automation",
			sub: "user-sub-1",
			roles: ["admin"],
		});
	});

	it("maps roles from a groups claim", async () => {
		const token = await mintToken(
			{ email: "someone@example.com", groups: ["emdash-labeler-reviewers"] },
			signKey,
		);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual(["reviewer"]);
	});

	it("grants only reviewer role for a reviewer-only principal", async () => {
		const token = await mintToken({ email: "reviewer@example.com" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual(["reviewer"]);
		expect(hasRole(identity, "reviewer")).toBe(true);
		expect(hasRole(identity, "admin")).toBe(false);
	});

	it("grants no roles when the principal matches neither list", async () => {
		const token = await mintToken({ email: "nobody@example.com" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual([]);
	});

	it("treats admin as inheriting reviewer capability via hasRole", async () => {
		const token = await mintToken({ email: "admin@example.com" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(hasRole(identity, "admin")).toBe(true);
		expect(hasRole(identity, "reviewer")).toBe(true);
	});

	it("rejects a token with the wrong audience", async () => {
		const token = await mintToken(
			{ email: "admin@example.com", audience: "wrong-audience" },
			signKey,
		);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a token with the wrong issuer", async () => {
		const token = await mintToken(
			{ email: "admin@example.com", issuer: "https://not-the-team.cloudflareaccess.com" },
			signKey,
		);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects an expired token", async () => {
		const token = await mintToken({ email: "admin@example.com", expiresInSeconds: -60 }, signKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a token that is not yet valid (nbf in the future)", async () => {
		const token = await mintToken(
			{ email: "admin@example.com", notBeforeInSeconds: 3600 },
			signKey,
		);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a token signed by a different key", async () => {
		const token = await mintToken({ email: "admin@example.com" }, otherKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a token signed with a non-RS256 algorithm even when its key verifies", async () => {
		const ecPair = await generateKeyPair("ES256");
		const ecResolver = (async () => ecPair.publicKey) as AccessKeyResolver;
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ sub: "user-sub-1", email: "admin@example.com" })
			.setProtectedHeader({ alg: "ES256" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience(AUDIENCE)
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(ecPair.privateKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				ecResolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects an HS256 token even when the resolved key would verify the signature", async () => {
		const secret = crypto.getRandomValues(new Uint8Array(32));
		const hmacResolver = (async () => secret) as AccessKeyResolver;
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ sub: "user-sub-1", email: "admin@example.com" })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience(AUDIENCE)
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(secret);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				hmacResolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects an unsigned alg:none token", async () => {
		const now = Math.floor(Date.now() / 1000);
		const encode = (value: unknown): string =>
			btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		const header = encode({ alg: "none", typ: "JWT" });
		const payload = encode({
			sub: "user-sub-1",
			email: "admin@example.com",
			iss: TEAM_DOMAIN,
			aud: AUDIENCE,
			exp: now + 3600,
		});
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": `${header}.${payload}.` }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a token that omits the exp claim", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ sub: "user-sub-1", email: "admin@example.com" })
			.setProtectedHeader({ alg: "RS256" })
			.setIssuer(TEAM_DOMAIN)
			.setAudience(AUDIENCE)
			.setIssuedAt(now)
			.sign(signKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a missing assertion header", async () => {
		await expect(
			verifyAccessRequest(requestWith({}), baseConfig(), resolver),
		).rejects.toMatchObject({ reason: "missing-token" });
	});

	it("never trusts a spoofed identity header without a verified assertion", async () => {
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Authenticated-User-Email": "admin@example.com" }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "missing-token" });
	});

	it("rejects a token with neither email nor common_name", async () => {
		const token = await mintToken({}, signKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("rejects a garbage assertion header", async () => {
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": "not-a-jwt" }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("ignores a groups claim of the wrong shape without crashing", async () => {
		const stringShape = await mintToken(
			{ email: "reviewer@example.com", groups: "emdash-labeler-reviewers" },
			signKey,
		);
		const numberArrayShape = await mintToken(
			{ email: "reviewer@example.com", groups: [1, 2, 3] },
			signKey,
		);

		const identityA = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": stringShape }),
			baseConfig(),
			resolver,
		);
		const identityB = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": numberArrayShape }),
			baseConfig(),
			resolver,
		);
		expect(identityA.roles).toEqual(["reviewer"]);
		expect(identityB.roles).toEqual(["reviewer"]);
	});

	it("does not treat an empty-string group entry as a principal", async () => {
		const token = await mintToken(
			{ email: "nobody@example.com", groups: ["", "not-a-configured-group"] },
			signKey,
		);
		// An empty-string allowlist entry can only match if an empty group leaks in as a principal.
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig({ admins: [""] }),
			resolver,
		);
		expect(identity.roles).toEqual([]);
	});

	it("never includes the raw token in a thrown error message", async () => {
		const token = await mintToken({ email: "admin@example.com" }, otherKey);
		try {
			await verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(AccessAuthError);
			expect((error as Error).message).not.toContain(token);
		}
	});
});

describe("parseAccessAuthConfig", () => {
	const validRaw = {
		teamDomain: TEAM_DOMAIN,
		audience: AUDIENCE,
		admins: ["emdash-labeler-admins"],
		reviewers: ["emdash-labeler-reviewers"],
	};

	it("parses a valid config", () => {
		expect(parseAccessAuthConfig(validRaw)).toEqual(
			baseConfig({ admins: validRaw.admins, reviewers: validRaw.reviewers }),
		);
	});

	it("rejects a missing or empty teamDomain", () => {
		expect(() => parseAccessAuthConfig({ ...validRaw, teamDomain: "" })).toThrow(TypeError);
		expect(() => parseAccessAuthConfig({ ...validRaw, teamDomain: undefined })).toThrow(TypeError);
	});

	it("rejects a non-https teamDomain", () => {
		expect(() =>
			parseAccessAuthConfig({
				...validRaw,
				teamDomain: "http://example-team.cloudflareaccess.com",
			}),
		).toThrow(TypeError);
	});

	it("rejects a teamDomain that is not a bare origin", () => {
		for (const teamDomain of [
			"https://example-team.cloudflareaccess.com/cdn-cgi/access/certs",
			"https://user:pass@example-team.cloudflareaccess.com",
			"https://example-team.cloudflareaccess.com?foo=bar",
			"https://example-team.cloudflareaccess.com#frag",
		])
			expect(() => parseAccessAuthConfig({ ...validRaw, teamDomain })).toThrow(TypeError);
	});

	it("accepts a trailing-slash teamDomain and normalizes it to a bare origin", () => {
		const config = parseAccessAuthConfig({
			...validRaw,
			teamDomain: `${TEAM_DOMAIN}/`,
		});
		expect(config.teamDomain).toBe(TEAM_DOMAIN);
	});

	it("rejects a missing audience", () => {
		expect(() => parseAccessAuthConfig({ ...validRaw, audience: "" })).toThrow(TypeError);
	});

	it("rejects non-array or empty-string admins/reviewers entries", () => {
		expect(() => parseAccessAuthConfig({ ...validRaw, admins: "not-an-array" })).toThrow(TypeError);
		expect(() => parseAccessAuthConfig({ ...validRaw, admins: [""] })).toThrow(TypeError);
		expect(() => parseAccessAuthConfig({ ...validRaw, reviewers: [123] })).toThrow(TypeError);
	});
});

describe("getAccessKeyResolver", () => {
	it("returns the same resolver instance for the same team domain", () => {
		const first = getAccessKeyResolver(TEAM_DOMAIN);
		const second = getAccessKeyResolver(TEAM_DOMAIN);
		expect(first).toBe(second);
	});

	it("returns distinct resolvers for distinct team domains", () => {
		const first = getAccessKeyResolver(TEAM_DOMAIN);
		const second = getAccessKeyResolver("https://other-team.cloudflareaccess.com");
		expect(first).not.toBe(second);
	});
});
