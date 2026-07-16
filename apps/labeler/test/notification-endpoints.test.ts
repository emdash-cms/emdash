import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
	ensureContact,
	getContactState,
	hashConfirmToken,
	isSuppressed,
	recipientHash,
	recordConfirmSent,
	suppress,
} from "../src/notification-contacts.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "test-notification-hash-pepper";
let seq = 0;

/** A distinct recipient hash per test, so rows never collide across cases. */
async function freshHash(): Promise<string> {
	seq++;
	return recipientHash(PEPPER, `notify-${seq}@example.test`);
}

/** Seed an unconfirmed contact carrying a pending confirmation token. */
async function seedPending(rawToken: string): Promise<string> {
	const hash = await freshHash();
	await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
	await recordConfirmSent(db(), hash, await hashConfirmToken(rawToken), 1_000);
	return hash;
}

function get(path: string, init?: RequestInit): Promise<Response> {
	return SELF.fetch(`https://labeler.test${path}`, init);
}

function post(path: string, fields: Record<string, string>): Promise<Response> {
	return SELF.fetch(`https://labeler.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("route mounting and Access bypass", () => {
	it("serves the confirm page without any Cloudflare Access assertion", async () => {
		const response = await get("/notifications/confirm");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
	});

	it("still guards /admin/api with Access (proving notifications are not behind it)", async () => {
		const response = await get("/admin/api/assessments", {
			headers: { "X-EmDash-Request": "1" },
		});
		expect(response.status).toBe(401);
	});

	it("sets no-store and no-referrer so the token does not leak downstream", async () => {
		const response = await get("/notifications/confirm?c=abc&t=xyz");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it("denies framing so the state-changing form cannot be clickjacked", async () => {
		const response = await get("/notifications/confirm?c=abc&t=xyz");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
	});

	it("rejects non-GET/POST methods with an Allow header", async () => {
		const response = await get("/notifications/confirm", { method: "PUT" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, POST");
	});
});

describe("GET does not mutate", () => {
	it("confirm GET renders a form and leaves the contact unconfirmed", async () => {
		const token = "confirm-token-get";
		const hash = await seedPending(token);

		const response = await get(`/notifications/confirm?c=${hash}&t=${encodeURIComponent(token)}`);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('<form method="post"');
		expect(body).toContain(`name="c" value="${hash}"`);

		expect((await getContactState(db(), hash))?.confirmState).toBe("unconfirmed");
	});

	it("unsubscribe GET renders a form and records no suppression", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");

		const response = await get(`/notifications/unsubscribe?c=${hash}`);
		expect(response.status).toBe(200);
		expect(await isSuppressed(db(), hash)).toBe(false);
	});

	it("escapes caller-supplied values reflected into the form", async () => {
		const response = await get(
			`/notifications/confirm?c=${encodeURIComponent('"><script>alert(1)</script>')}`,
		);
		const body = await response.text();
		expect(body).not.toContain("<script>alert(1)</script>");
		expect(body).toContain("&lt;script&gt;");
	});
});

describe("confirm", () => {
	it("confirms an unconfirmed contact on a valid token", async () => {
		const token = "confirm-token-valid";
		const hash = await seedPending(token);

		const response = await post("/notifications/confirm", { c: hash, t: token });
		expect(response.status).toBe(200);

		const state = await getContactState(db(), hash);
		expect(state?.confirmState).toBe("confirmed");
		expect(state?.confirmTokenHash).toBeNull();
	});

	it("is an idempotent no-op once already confirmed", async () => {
		const token = "confirm-token-twice";
		const hash = await seedPending(token);

		const first = await post("/notifications/confirm", { c: hash, t: token });
		const second = await post("/notifications/confirm", { c: hash, t: token });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.text()).toBe(await second.text());
		expect((await getContactState(db(), hash))?.confirmState).toBe("confirmed");
	});

	it("never confirms a suppressed contact even with a matching token", async () => {
		const token = "confirm-token-suppressed";
		const hash = await seedPending(token);
		// A suppression that did not decline the contact (e.g. a hard bounce)
		// leaves an unconfirmed row with a live token; the endpoint's suppression
		// guard must still refuse the confirm.
		await suppress(db(), hash, "bounce", "2026-07-16T00:00:00.000Z", 1_000);

		const response = await post("/notifications/confirm", { c: hash, t: token });
		expect(response.status).toBe(200);
		expect((await getContactState(db(), hash))?.confirmState).toBe("unconfirmed");
	});

	it("returns the same neutral page for valid, wrong, and unknown tokens", async () => {
		const token = "confirm-token-uniform";
		const validHash = await seedPending(token);
		const wrongHash = await seedPending(token);
		const unknownHash = await freshHash();

		const valid = await post("/notifications/confirm", { c: validHash, t: token });
		const wrong = await post("/notifications/confirm", { c: wrongHash, t: "not-the-token" });
		const unknown = await post("/notifications/confirm", { c: unknownHash, t: token });
		const malformed = await post("/notifications/confirm", { c: "not-a-hash", t: token });

		const validBody = await valid.text();
		expect(await wrong.text()).toBe(validBody);
		expect(await unknown.text()).toBe(validBody);
		expect(await malformed.text()).toBe(validBody);
		for (const response of [valid, wrong, unknown, malformed]) expect(response.status).toBe(200);

		// The neutral page did not confirm the contacts that should not have been.
		expect((await getContactState(db(), wrongHash))?.confirmState).toBe("unconfirmed");
		expect(await getContactState(db(), unknownHash)).toBeNull();
	});
});

describe("unsubscribe", () => {
	it("records a suppression and is idempotent, keeping the first reason", async () => {
		const hash = await freshHash();
		await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");

		const first = await post("/notifications/unsubscribe", { c: hash });
		const second = await post("/notifications/unsubscribe", { c: hash });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await isSuppressed(db(), hash)).toBe(true);
		expect(await reasonFor(hash)).toBe("unsubscribe");
		expect((await getContactState(db(), hash))?.confirmState).toBe("declined");
	});

	it("writes no row for a malformed recipient hash", async () => {
		const response = await post("/notifications/unsubscribe", { c: "bogus" });
		expect(response.status).toBe(200);
		const count = await db()
			.prepare("SELECT COUNT(*) AS n FROM notification_suppressions WHERE recipient_hash = ?")
			.bind("bogus")
			.first<{ n: number }>();
		expect(count?.n).toBe(0);
	});
});

describe("not-me", () => {
	it("suppresses with the not_me reason and declines any pending confirmation", async () => {
		const hash = await seedPending("pending-token");

		const response = await post("/notifications/not-me", { c: hash });
		expect(response.status).toBe(200);
		expect(await isSuppressed(db(), hash)).toBe(true);
		expect(await reasonFor(hash)).toBe("not_me");
		expect((await getContactState(db(), hash))?.confirmState).toBe("declined");
	});

	it("writes no suppression for a well-formed hash with no contact row, yet returns the same done page", async () => {
		// A recipient who legitimately received mail always has a contact row, so
		// a well-formed hash with none is an attacker-fabricated value: it must
		// write no orphan suppression row while staying response-uniform.
		const seeded = await freshHash();
		await ensureContact(db(), seeded, "2026-07-16T00:00:00.000Z");
		const suppressed = await post("/notifications/not-me", { c: seeded });

		const orphan = await freshHash();
		const noop = await post("/notifications/not-me", { c: orphan });

		expect(noop.status).toBe(200);
		expect(await noop.text()).toBe(await suppressed.text());
		expect(await isSuppressed(db(), orphan)).toBe(false);
		expect(await reasonFor(orphan)).toBeUndefined();
		// The seeded contact, which does exist, was suppressed.
		expect(await isSuppressed(db(), seeded)).toBe(true);
	});
});

async function reasonFor(hash: string): Promise<string | undefined> {
	const row = await db()
		.prepare("SELECT reason FROM notification_suppressions WHERE recipient_hash = ?")
		.bind(hash)
		.first<{ reason: string }>();
	return row?.reason;
}
