/**
 * Tests for the reviews and ratings system.
 *
 * Tests review CRUD, rating denormalization, publisher replies,
 * auth, rate limiting, and edge cases.
 */

import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { SignJWT } from "jose";
import { describe, it, expect, beforeEach } from "vitest";

// Polyfill crypto.subtle.timingSafeEqual (Workers API not in Node)
const subtle = crypto.subtle as unknown as Record<string, unknown>;
if (!subtle.timingSafeEqual) {
	subtle.timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
		return nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b));
	};
}

import app from "../src/app.js";
import { resetRateLimiter } from "../src/routes/reviews.js";

// ── D1 mock ─────────────────────────────────────────────────────

function createD1Mock() {
	const db = new Database(":memory:");
	const schemaPath = resolve(import.meta.dirname, "../src/db/schema.sql");
	const schema = readFileSync(schemaPath, "utf-8");
	db.exec(schema);

	return {
		_db: db,
		prepare(query: string) {
			return {
				_query: query,
				_bindings: [] as unknown[],
				bind(...args: unknown[]) {
					this._bindings = args;
					return this;
				},
				async first<T = unknown>(column?: string): Promise<T | null> {
					const stmt = db.prepare(this._query);
					const row = stmt.get(...this._bindings) as Record<string, unknown> | undefined;
					if (!row) return null;
					if (column) return (row[column] ?? null) as T;
					return row as T;
				},
				async all<T = unknown>(): Promise<{ results: T[] }> {
					const stmt = db.prepare(this._query);
					const rows = stmt.all(...this._bindings) as T[];
					return { results: rows };
				},
				async run() {
					const stmt = db.prepare(this._query);
					const result = stmt.run(...this._bindings);
					return {
						success: true,
						meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
					};
				},
			};
		},
		async batch(statements: { _query: string; _bindings: unknown[] }[]) {
			const results = [];
			for (const stmt of statements) {
				const s = db.prepare(stmt._query);
				results.push(s.run(...stmt._bindings));
			}
			return results;
		},
	};
}

// ── Helpers ───────────────────────────────────────────────────

const JWT_SECRET = "test-jwt-secret";

function makeEnv(db: ReturnType<typeof createD1Mock>) {
	return {
		DB: db,
		R2: {
			async put() {},
			async get() {
				return null;
			},
			async head() {
				return null;
			},
		},
		SEED_TOKEN: "test-seed",
		GITHUB_CLIENT_ID: "test",
		GITHUB_CLIENT_SECRET: JWT_SECRET,
		AUDIT_ENFORCEMENT: "none",
	};
}

async function makeJwt(authorId: string): Promise<string> {
	const key = new TextEncoder().encode(JWT_SECRET);
	return new SignJWT({ sub: authorId })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(key);
}

function seedAuthor(db: ReturnType<typeof createD1Mock>["_db"], id: string, name: string) {
	db.prepare(
		"INSERT OR IGNORE INTO authors (id, github_id, name, verified) VALUES (?, ?, ?, 1)",
	).run(id, `gh-${id}`, name);
}

function seedPlugin(db: ReturnType<typeof createD1Mock>["_db"], id: string, authorId: string) {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO plugins (id, name, author_id, capabilities, rating_avg, rating_count, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
	).run(id, id, authorId, JSON.stringify(["hooks"]), now, now);

	db.prepare(
		`INSERT INTO plugin_versions (id, plugin_id, version, bundle_key, bundle_size, checksum, capabilities, status, published_at)
		VALUES (?, ?, '1.0.0', 'key', 1024, 'abc', ?, 'published', ?)`,
	).run(`${id}-v1`, id, JSON.stringify(["hooks"]), now);
}

// ── Tests ─────────────────────────────────────────────────────

describe("review CRUD", () => {
	let d1: ReturnType<typeof createD1Mock>;
	let env: Record<string, unknown>;
	let reviewerToken: string;

	beforeEach(async () => {
		resetRateLimiter();
		d1 = createD1Mock();
		env = makeEnv(d1);

		seedAuthor(d1._db, "publisher-1", "Plugin Author");
		seedAuthor(d1._db, "reviewer-1", "Reviewer");
		seedPlugin(d1._db, "test-plugin", "publisher-1");

		reviewerToken = await makeJwt("reviewer-1");
	});

	it("creates a review", async () => {
		const res = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 4, body: "Great plugin!" }),
			},
			env,
		);

		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; rating: number; body: string };
		expect(body.rating).toBe(4);
		expect(body.body).toBe("Great plugin!");
	});

	it("rejects duplicate review from same author", async () => {
		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 4 }),
			},
			env,
		);

		// Reset rate limiter so the second request reaches the DB constraint check
		resetRateLimiter();

		const res = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);

		expect(res.status).toBe(409);
	});

	it("lists reviews for a plugin", async () => {
		// Create a review first
		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 5, body: "Excellent!" }),
			},
			env,
		);

		const res = await app.request("/api/v1/plugins/test-plugin/reviews", {}, env);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { items: { rating: number; body: string }[] };
		expect(data.items.length).toBe(1);
		expect(data.items[0]!.rating).toBe(5);
	});

	it("updates own review", async () => {
		const createRes = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 3 }),
			},
			env,
		);
		const created = (await createRes.json()) as { id: string };

		const res = await app.request(
			`/api/v1/plugins/test-plugin/reviews/${created.id}`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 5, body: "Changed my mind!" }),
			},
			env,
		);

		expect(res.status).toBe(200);
		const updated = (await res.json()) as { rating: number; body: string };
		expect(updated.rating).toBe(5);
		expect(updated.body).toBe("Changed my mind!");
	});

	it("deletes own review", async () => {
		const createRes = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 4 }),
			},
			env,
		);
		const created = (await createRes.json()) as { id: string };

		const res = await app.request(
			`/api/v1/plugins/test-plugin/reviews/${created.id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${reviewerToken}` },
			},
			env,
		);

		expect(res.status).toBe(200);

		// Verify it's gone
		const listRes = await app.request("/api/v1/plugins/test-plugin/reviews", {}, env);
		const data = (await listRes.json()) as { items: unknown[] };
		expect(data.items.length).toBe(0);
	});

	it("requires auth for review submission", async () => {
		const res = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);

		expect(res.status).toBe(401);
	});

	it("validates rating range", async () => {
		const res = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 6 }),
			},
			env,
		);

		expect(res.status).toBe(400);
	});

	it("returns 404 for review on nonexistent plugin", async () => {
		const res = await app.request(
			"/api/v1/plugins/nonexistent/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);

		expect(res.status).toBe(404);
	});

	it("rate limits repeated submissions", async () => {
		// Create a second plugin so same author can review a different one
		seedPlugin(d1._db, "other-plugin", "publisher-1");

		// First review succeeds
		const res1 = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);
		expect(res1.status).toBe(201);

		// Second review within rate limit window is rejected
		const res2 = await app.request(
			"/api/v1/plugins/other-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 4 }),
			},
			env,
		);
		expect(res2.status).toBe(429);
	});

	it("sanitizes HTML in review body", async () => {
		const res = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${reviewerToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ rating: 4, body: "Nice plugin <script>alert('xss')</script>" }),
			},
			env,
		);

		expect(res.status).toBe(201);
		const data = (await res.json()) as { body: string };
		expect(data.body).toBe("Nice plugin alert('xss')");
		expect(data.body).not.toContain("<script>");
	});
});

describe("rating denormalization", () => {
	let d1: ReturnType<typeof createD1Mock>;
	let env: Record<string, unknown>;

	beforeEach(async () => {
		resetRateLimiter();
		d1 = createD1Mock();
		env = makeEnv(d1);

		seedAuthor(d1._db, "publisher-1", "Publisher");
		seedAuthor(d1._db, "reviewer-1", "Reviewer 1");
		seedAuthor(d1._db, "reviewer-2", "Reviewer 2");
		seedAuthor(d1._db, "reviewer-3", "Reviewer 3");
		seedPlugin(d1._db, "test-plugin", "publisher-1");
	});

	it("updates rating_avg and rating_count on the plugins table", async () => {
		const token1 = await makeJwt("reviewer-1");
		const token2 = await makeJwt("reviewer-2");

		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token1}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 4 }),
			},
			env,
		);

		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 2 }),
			},
			env,
		);

		const plugin = d1._db
			.prepare("SELECT rating_avg, rating_count FROM plugins WHERE id = ?")
			.get("test-plugin") as { rating_avg: number; rating_count: number };

		expect(plugin.rating_count).toBe(2);
		expect(plugin.rating_avg).toBe(3); // (4+2)/2
	});

	it("recalculates on review delete", async () => {
		const token1 = await makeJwt("reviewer-1");
		const token2 = await makeJwt("reviewer-2");

		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token1}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);

		const createRes = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token2}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 1 }),
			},
			env,
		);
		const created = (await createRes.json()) as { id: string };

		// Delete the 1-star review
		await app.request(
			`/api/v1/plugins/test-plugin/reviews/${created.id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${token2}` },
			},
			env,
		);

		const plugin = d1._db
			.prepare("SELECT rating_avg, rating_count FROM plugins WHERE id = ?")
			.get("test-plugin") as { rating_avg: number; rating_count: number };

		expect(plugin.rating_count).toBe(1);
		expect(plugin.rating_avg).toBe(5);
	});

	it("plugin detail hides rating when count < 3", async () => {
		const token = await makeJwt("reviewer-1");

		await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 5 }),
			},
			env,
		);

		const detailRes = await app.request("/api/v1/plugins/test-plugin", {}, env);
		const detail = (await detailRes.json()) as { rating: unknown };
		expect(detail.rating).toBeNull();
	});

	it("plugin detail shows rating when count >= 3", async () => {
		const token1 = await makeJwt("reviewer-1");
		const token2 = await makeJwt("reviewer-2");
		const token3 = await makeJwt("reviewer-3");

		for (const [token, rating] of [
			[token1, 5],
			[token2, 4],
			[token3, 3],
		] as const) {
			await app.request(
				"/api/v1/plugins/test-plugin/reviews",
				{
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ rating }),
				},
				env,
			);
		}

		const detailRes = await app.request("/api/v1/plugins/test-plugin", {}, env);
		const detail = (await detailRes.json()) as { rating: { average: number; count: number } };
		expect(detail.rating).not.toBeNull();
		expect(detail.rating.count).toBe(3);
		expect(detail.rating.average).toBe(4); // (5+4+3)/3
	});
});

describe("publisher reply", () => {
	let d1: ReturnType<typeof createD1Mock>;
	let env: Record<string, unknown>;

	beforeEach(async () => {
		resetRateLimiter();
		d1 = createD1Mock();
		env = makeEnv(d1);

		seedAuthor(d1._db, "publisher-1", "Publisher");
		seedAuthor(d1._db, "reviewer-1", "Reviewer");
		seedPlugin(d1._db, "test-plugin", "publisher-1");
	});

	it("allows plugin owner to reply to a review", async () => {
		const reviewerToken = await makeJwt("reviewer-1");
		const publisherToken = await makeJwt("publisher-1");

		const createRes = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${reviewerToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 3, body: "Could be better" }),
			},
			env,
		);
		const review = (await createRes.json()) as { id: string };

		const res = await app.request(
			`/api/v1/plugins/test-plugin/reviews/${review.id}/reply`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${publisherToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ body: "Thanks for the feedback!" }),
			},
			env,
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as { publisherReply: string };
		expect(data.publisherReply).toBe("Thanks for the feedback!");
	});

	it("rejects reply from non-owner", async () => {
		const reviewerToken = await makeJwt("reviewer-1");

		const createRes = await app.request(
			"/api/v1/plugins/test-plugin/reviews",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${reviewerToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ rating: 3 }),
			},
			env,
		);
		const review = (await createRes.json()) as { id: string };

		// Reviewer tries to reply (not the plugin owner)
		const res = await app.request(
			`/api/v1/plugins/test-plugin/reviews/${review.id}/reply`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${reviewerToken}`, "Content-Type": "application/json" },
				body: JSON.stringify({ body: "Fake reply" }),
			},
			env,
		);

		expect(res.status).toBe(404);
	});
});
