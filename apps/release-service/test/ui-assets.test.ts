import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { handleUiRequest } from "../src/index.js";
import { TEST_ACCESS_AUDIENCES, TEST_BINDINGS } from "./fixtures/oauth.js";

const ACCESS_SUBJECT = "7335d417-61da-459d-899c-0a01c76a2f94";
let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
	const keys = await generateKeyPair("RS256", { extractable: true });
	privateKey = keys.privateKey;
	const publicJwk = await exportJWK(keys.publicKey);
	publicJwk.kid = "access-ui-test";
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

async function accessToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return await new SignJWT({ email: "operator@example.com", type: "app" })
		.setProtectedHeader({ alg: "RS256", kid: "access-ui-test", typ: "JWT" })
		.setIssuer(TEST_BINDINGS.ACCESS_TEAM_DOMAIN)
		.setAudience(TEST_ACCESS_AUDIENCES.viewer)
		.setSubject(ACCESS_SUBJECT)
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

describe("release-service UI assets", () => {
	it("serves publisher SPA navigation with strict security headers", async () => {
		const response = await handleUiRequest(
			new Request("https://release.example.com/publisher"),
			env,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(await response.text()).toContain('<div id="root"></div>');
	});

	it("requires a verified Access audience before serving operator navigation", async () => {
		const routed = await SELF.fetch("https://release.example.com/admin");
		expect(routed.status).toBe(401);
		expect(routed.headers.get("content-type")).toContain("application/json");

		const denied = await handleUiRequest(
			new Request("https://release.example.com/admin"),
			env,
			keyResolver,
		);
		expect(denied.status).toBe(401);

		const allowed = await handleUiRequest(
			new Request("https://release.example.com/admin", {
				headers: { "cf-access-jwt-assertion": await accessToken() },
			}),
			env,
			keyResolver,
		);
		expect(allowed.status).toBe(200);
		expect(allowed.headers.get("content-type")).toContain("text/html");
	});
});
