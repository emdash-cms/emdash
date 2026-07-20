import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { AccessAuthConfig, AccessKeyResolver } from "../src/access-auth.js";
import { OPERATOR_REQUEST_HEADER } from "../src/mutation-guard.js";
import { guardRead, type ReadGuardDeps } from "../src/operator-read-guard.js";

const TEAM_DOMAIN = "https://example-team.cloudflareaccess.com";
const AUDIENCE = "test-audience";
const ORIGIN = "https://labeler.example.com";

let signKey: CryptoKey;
let resolver: AccessKeyResolver;
let adminToken: string;
let reviewerToken: string;
let noRoleToken: string;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	signKey = pair.privateKey;
	resolver = (async () => pair.publicKey) as AccessKeyResolver;
	adminToken = await mintToken({ email: "admin@example.com" });
	reviewerToken = await mintToken({ email: "reviewer@example.com" });
	noRoleToken = await mintToken({ email: "nobody@example.com" });
});

async function mintToken(claims: Record<string, unknown>): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ sub: "user-sub-1", ...claims })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuer(TEAM_DOMAIN)
		.setAudience(AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(signKey);
}

function baseConfig(): AccessAuthConfig {
	return {
		teamDomain: TEAM_DOMAIN,
		audience: AUDIENCE,
		admins: ["admin@example.com"],
		reviewers: ["reviewer@example.com"],
	};
}

function deps(overrides: Partial<ReadGuardDeps> = {}): ReadGuardDeps {
	return { config: baseConfig(), keys: resolver, expectedOrigin: ORIGIN, ...overrides };
}

interface RequestOptions {
	token?: string;
	csrf?: string | null;
	origin?: string;
	secFetchSite?: string;
	spoofEmail?: string;
}

function buildRequest(opts: RequestOptions = {}): Request {
	const headers = new Headers();
	const csrf = opts.csrf === undefined ? "1" : opts.csrf;
	if (csrf !== null) headers.set(OPERATOR_REQUEST_HEADER, csrf);
	if (opts.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", opts.token);
	if (opts.origin !== undefined) headers.set("Origin", opts.origin);
	if (opts.secFetchSite !== undefined) headers.set("Sec-Fetch-Site", opts.secFetchSite);
	if (opts.spoofEmail !== undefined)
		headers.set("Cf-Access-Authenticated-User-Email", opts.spoofEmail);
	return new Request(`${ORIGIN}/admin/api/assessments`, { method: "GET", headers });
}

async function expectRejection(request: Request, code: string, status: number): Promise<void> {
	await expect(guardRead(request, deps(), { minRole: "reviewer" })).rejects.toMatchObject({
		code,
		status,
	});
}

describe("guardRead — transport checks", () => {
	it("rejects a mismatching Origin", async () => {
		await expectRejection(
			buildRequest({ token: reviewerToken, origin: "https://evil.example.com" }),
			"CROSS_ORIGIN",
			403,
		);
	});

	it("rejects a cross-site Sec-Fetch-Site", async () => {
		await expectRejection(
			buildRequest({ token: reviewerToken, secFetchSite: "cross-site" }),
			"CROSS_ORIGIN",
			403,
		);
	});

	it("rejects a missing CSRF header", async () => {
		await expectRejection(
			buildRequest({ token: reviewerToken, csrf: null }),
			"CSRF_HEADER_MISSING",
			403,
		);
	});

	it("rejects a wrong CSRF header value", async () => {
		await expectRejection(
			buildRequest({ token: reviewerToken, csrf: "0" }),
			"CSRF_HEADER_MISSING",
			403,
		);
	});

	it("passes when both Origin and Sec-Fetch-Site are absent (non-browser client)", async () => {
		const identity = await guardRead(buildRequest({ token: reviewerToken }), deps(), {
			minRole: "reviewer",
		});
		expect(identity.roles).toContain("reviewer");
	});
});

describe("guardRead — authentication", () => {
	it("rejects a request with no assertion header", async () => {
		await expectRejection(buildRequest({}), "UNAUTHENTICATED", 401);
	});

	it("rejects an invalid assertion", async () => {
		await expectRejection(buildRequest({ token: "not-a-jwt" }), "UNAUTHENTICATED", 401);
	});

	it("never derives identity from a spoofed plaintext email header", async () => {
		await expectRejection(
			buildRequest({ spoofEmail: "admin@example.com" }),
			"UNAUTHENTICATED",
			401,
		);
	});
});

describe("guardRead — role gate", () => {
	it("rejects an edge-authenticated identity that maps to no role", async () => {
		await expectRejection(buildRequest({ token: noRoleToken }), "FORBIDDEN_ROLE", 403);
	});

	it("admits a reviewer", async () => {
		const identity = await guardRead(buildRequest({ token: reviewerToken }), deps(), {
			minRole: "reviewer",
		});
		expect(identity).toMatchObject({ kind: "human", email: "reviewer@example.com" });
	});

	it("admits an admin by inheritance", async () => {
		const identity = await guardRead(buildRequest({ token: adminToken }), deps(), {
			minRole: "reviewer",
		});
		expect(identity.roles).toContain("admin");
	});
});
