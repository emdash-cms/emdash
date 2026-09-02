import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { operatorActorDid, parseAccessAuthConfig, verifyAccessRequest } from "../src/access.js";

describe("operator Access authentication", () => {
	it("verifies issuer, audience, expiry, identity, and configured reviewer role", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const token = await new SignJWT({ email: "reviewer@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer("https://team.cloudflareaccess.com")
			.setAudience("labeler-audience")
			.setSubject("access-user-1")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const config = parseAccessAuthConfig({
			teamDomain: "https://team.cloudflareaccess.com",
			audience: "labeler-audience",
			admins: [],
			reviewers: ["reviewer@example.com"],
		});
		const identity = await verifyAccessRequest(
			new Request("https://labels.example/_admin", {
				headers: { "Cf-Access-Jwt-Assertion": token },
			}),
			config,
			async (protectedHeader) => {
				expect(protectedHeader.kid).toBe("test");
				return publicKey;
			},
		);
		expect(identity).toMatchObject({
			kind: "human",
			email: "reviewer@example.com",
			sub: "access-user-1",
			roles: ["reviewer"],
		});
		expect(await operatorActorDid(identity)).toMatch(/^did:web:labels\.emdashcms\.com:operators:/);
		expect(await exportJWK(publicKey)).toHaveProperty("kty", "RSA");
	});

	it("rejects unverified identity headers and mismatched config", async () => {
		const config = parseAccessAuthConfig({
			teamDomain: "https://team.cloudflareaccess.com",
			audience: "labeler-audience",
			admins: [],
			reviewers: [],
		});
		await expect(
			verifyAccessRequest(
				new Request("https://labels.example/_admin", {
					headers: { "Cf-Access-Authenticated-User-Email": "attacker@example.com" },
				}),
				config,
				async () => {
					throw new Error("must not resolve a key");
				},
			),
		).rejects.toThrow(/assertion/);
		expect(() =>
			parseAccessAuthConfig({
				teamDomain: "http://team.example",
				audience: "aud",
				admins: [],
				reviewers: [],
			}),
		).toThrow(/HTTPS origin/);
	});
});
