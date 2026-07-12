/**
 * Request-scoped labeler-policy resolution (W4.4): the deployment default
 * when `atproto-accept-labelers` is absent, explicit-header parsing and
 * availability filtering, and the response-side `atproto-content-labelers` /
 * CORS surface `router.ts` builds around it. Handlers don't yet act on the
 * resolved policy (W4.5/W4.6) — these tests only exercise resolution and
 * the header contract, via `getPackage` as a cheap endpoint.
 */

import { NSID } from "@emdash-cms/registry-lexicons";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

const NOW = new Date("2026-07-11T12:00:00.000Z");
const TRUSTED_DID = "did:web:trusted-labeler.example";
const UNTRUSTED_DID = "did:web:untrusted-labeler.example";
const UNKNOWN_DID = "did:web:unknown-labeler.example";
// No package is seeded for this DID/slug; the handler 404s, but resolution
// and header-setting happen in `handleXrpc` regardless of the response.
const GET_PACKAGE_URL = `https://test/xrpc/${NSID.aggregatorGetPackage}?did=did:plc:read000000000000000000aa&slug=missing`;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await testEnv.DB.prepare("DELETE FROM labelers").run();
});

async function seedLabeler(did: string, trusted: boolean): Promise<void> {
	await testEnv.DB.prepare(
		`INSERT INTO labelers (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			did,
			"https://labeler.example",
			"unused-in-tests",
			`${did}#atproto_label`,
			trusted ? 1 : 0,
			NOW.toISOString(),
			NOW.toISOString(),
		)
		.run();
}

describe("request labeler policy", () => {
	it("defaults to every trusted labeler with redact:true when the header is missing", async () => {
		await seedLabeler(TRUSTED_DID, true);
		await seedLabeler(UNTRUSTED_DID, false);

		const res = await SELF.fetch(GET_PACKAGE_URL);
		expect(res.headers.get("atproto-content-labelers")).toBe(`${TRUSTED_DID};redact`);
	});

	it("disables the default set and omits the response header when the header is present but empty", async () => {
		await seedLabeler(TRUSTED_DID, true);

		const res = await SELF.fetch(GET_PACKAGE_URL, {
			headers: { "atproto-accept-labelers": "" },
		});
		expect(res.headers.has("atproto-content-labelers")).toBe(false);
	});

	it("400s with an InvalidRequest envelope on malformed header syntax", async () => {
		const res = await SELF.fetch(GET_PACKAGE_URL, {
			headers: { "atproto-accept-labelers": "not-a-valid-did" },
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; message?: string };
		expect(body.error).toBe("InvalidRequest");
		expect(typeof body.message).toBe("string");
	});

	it("merges repeated DIDs in the explicit header, OR-ing redact", async () => {
		await seedLabeler(TRUSTED_DID, true);

		const res = await SELF.fetch(GET_PACKAGE_URL, {
			headers: { "atproto-accept-labelers": `${TRUSTED_DID}, ${TRUSTED_DID};redact` },
		});
		expect(res.headers.get("atproto-content-labelers")).toBe(`${TRUSTED_DID};redact`);
	});

	it("omits an unavailable DID from the explicit header", async () => {
		await seedLabeler(TRUSTED_DID, true);

		const res = await SELF.fetch(GET_PACKAGE_URL, {
			headers: { "atproto-accept-labelers": `${UNKNOWN_DID}, ${TRUSTED_DID}` },
		});
		expect(res.headers.get("atproto-content-labelers")).toBe(TRUSTED_DID);
	});

	it("accepts and echoes an explicit untrusted-but-configured DID", async () => {
		await seedLabeler(UNTRUSTED_DID, false);

		const res = await SELF.fetch(GET_PACKAGE_URL, {
			headers: { "atproto-accept-labelers": UNTRUSTED_DID },
		});
		expect(res.headers.get("atproto-content-labelers")).toBe(UNTRUSTED_DID);
	});

	it("lists the right allow/expose headers on the OPTIONS preflight", async () => {
		const res = await SELF.fetch(GET_PACKAGE_URL, { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-headers")).toBe(
			"content-type, atproto-accept-labelers",
		);
		expect(res.headers.get("access-control-expose-headers")).toBe(
			"atproto-content-labelers, content-language",
		);
	});
});
