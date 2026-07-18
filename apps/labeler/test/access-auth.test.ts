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
	custom?: unknown;
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

	it("accepts a valid service token identified by common_name (empty sub)", async () => {
		// Cloudflare Access sets sub: "" for non-identity (service-token) JWTs and
		// identifies the token via common_name (the CF-Access-Client-Id).
		const token = await mintToken({ common_name: "ci-automation", sub: "" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig({ admins: ["ci-automation"] }),
			resolver,
		);
		expect(identity).toEqual<OperatorIdentity>({
			kind: "service",
			commonName: "ci-automation",
			sub: "",
			roles: ["admin"],
		});
	});

	it("rejects a human token with an empty sub", async () => {
		// An empty sub is only legitimate for a service token (common_name path);
		// a human/email identity must carry a non-empty subject.
		const token = await mintToken({ email: "admin@example.com", sub: "" }, signKey);
		await expect(
			verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			),
		).rejects.toMatchObject({ reason: "invalid-token" });
	});

	it("maps roles from a groups claim nested under the verified custom object", async () => {
		const token = await mintToken(
			{ email: "someone@example.com", custom: { groups: ["emdash-labeler-reviewers"] } },
			signKey,
		);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual(["reviewer"]);
	});

	it("ignores a top-level groups claim (Access places IdP groups under custom)", async () => {
		const token = await mintToken(
			{ email: "someone@example.com", groups: ["emdash-labeler-admins"] },
			signKey,
		);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual([]);
	});

	it("maps both admin and reviewer when custom.groups lists both", async () => {
		const token = await mintToken(
			{
				email: "someone@example.com",
				custom: { groups: ["emdash-labeler-admins", "emdash-labeler-reviewers"] },
			},
			signKey,
		);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": token }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual(["admin", "reviewer"]);
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

	it("ignores malformed custom / groups shapes without crashing", async () => {
		// custom itself is not an object; custom.groups is a string not an array;
		// custom.groups is a non-string array; custom is absent. None should throw
		// and none should leak a group principal — the reviewer role here comes
		// only from the email allowlist.
		const shapes: unknown[] = [
			"custom-is-a-string",
			{ groups: "emdash-labeler-reviewers" },
			{ groups: [1, 2, 3] },
			{ groups: { nested: true } },
		];
		for (const custom of shapes) {
			const token = await mintToken({ email: "reviewer@example.com", custom }, signKey);
			const identity = await verifyAccessRequest(
				requestWith({ "Cf-Access-Jwt-Assertion": token }),
				baseConfig(),
				resolver,
			);
			expect(identity.roles).toEqual(["reviewer"]);
		}

		const noCustom = await mintToken({ email: "reviewer@example.com" }, signKey);
		const identity = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": noCustom }),
			baseConfig(),
			resolver,
		);
		expect(identity.roles).toEqual(["reviewer"]);
	});

	it("does not treat an empty-string custom group entry as a principal", async () => {
		const token = await mintToken(
			{ email: "nobody@example.com", custom: { groups: ["", "not-a-configured-group"] } },
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

	it("never lets a service token gain a role from custom.groups (service = common_name only)", async () => {
		// A service token carries no IdP identity, so a `custom.groups` that
		// happens to match an allowlist entry must NOT confer a role — otherwise
		// moving the group claim under `custom` opens a fail-open path.
		const unauthorized = await mintToken(
			{ common_name: "unknown-service", sub: "", custom: { groups: ["emdash-labeler-admins"] } },
			signKey,
		);
		const identityA = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": unauthorized }),
			baseConfig(),
			resolver,
		);
		expect(identityA.roles).toEqual([]);

		// A service token authorized by common_name keeps exactly that role; a
		// reviewer group in its custom object adds nothing.
		const authorized = await mintToken(
			{ common_name: "ci-automation", sub: "", custom: { groups: ["emdash-labeler-reviewers"] } },
			signKey,
		);
		const identityB = await verifyAccessRequest(
			requestWith({ "Cf-Access-Jwt-Assertion": authorized }),
			baseConfig({ admins: ["ci-automation"] }),
			resolver,
		);
		expect(identityB).toEqual<OperatorIdentity>({
			kind: "service",
			commonName: "ci-automation",
			sub: "",
			roles: ["admin"],
		});
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
