/**
 * Tests for categories, FTS5 search, and category filtering.
 *
 * Uses the same D1 mock pattern as publish-e2e.test.ts:
 * better-sqlite3 in-memory DB bootstrapped from schema.sql.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";

import app from "../src/app.js";

// ── D1 mock using better-sqlite3 ──────────────────────────────

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

const SEED_TOKEN = "test-seed-token";

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
		SEED_TOKEN,
		GITHUB_CLIENT_ID: "test",
		GITHUB_CLIENT_SECRET: "test-secret",
		AUDIT_ENFORCEMENT: "none",
	};
}

/** Insert a test plugin directly into the DB for query testing. */
function seedPlugin(
	db: ReturnType<typeof createD1Mock>["_db"],
	id: string,
	opts: { name?: string; description?: string; keywords?: string[] } = {},
) {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO authors (id, github_id, name, verified) VALUES (?, ?, ?, 1)`,
	).run("author-1", "12345", "Test Author");

	db.prepare(
		`INSERT OR IGNORE INTO plugins (id, name, description, author_id, capabilities, keywords, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		opts.name ?? id,
		opts.description ?? `Description for ${id}`,
		"author-1",
		JSON.stringify(["hooks"]),
		opts.keywords ? JSON.stringify(opts.keywords) : null,
		now,
		now,
	);

	// Add a published version so it shows up in search
	db.prepare(
		`INSERT INTO plugin_versions (id, plugin_id, version, bundle_key, bundle_size, checksum, capabilities, status, published_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
	).run(
		`${id}-v1`,
		id,
		"1.0.0",
		`bundles/${id}/1.0.0`,
		1024,
		"abc123",
		JSON.stringify(["hooks"]),
		now,
	);
}

// ── Tests ─────────────────────────────────────────────────────

describe("categories API", () => {
	let env: Record<string, unknown>;

	beforeEach(() => {
		env = makeEnv(createD1Mock());
	});

	it("GET /categories returns seeded categories", async () => {
		const res = await app.request("/api/v1/categories", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { slug: string; name: string }[] };
		expect(body.items.length).toBe(12);
		expect(body.items[0]!.slug).toBe("seo");
		expect(body.items[0]!.name).toBe("SEO & Metadata");
		// Sorted by sort_order
		expect(body.items[11]!.slug).toBe("ecommerce");
	});
});

describe("category filtering", () => {
	let d1: ReturnType<typeof createD1Mock>;
	let env: Record<string, unknown>;

	beforeEach(() => {
		d1 = createD1Mock();
		env = makeEnv(d1);

		// Seed two plugins
		seedPlugin(d1._db, "seo-plugin", { name: "SEO Plugin", keywords: ["seo"] });
		seedPlugin(d1._db, "forms-plugin", { name: "Forms Plugin", keywords: ["forms"] });

		// Assign seo-plugin to the "seo" category
		d1._db
			.prepare("INSERT INTO plugin_categories (plugin_id, category_id) VALUES (?, ?)")
			.run("seo-plugin", "cat_seo");
	});

	it("GET /plugins?category=seo returns only plugins in that category", async () => {
		const res = await app.request("/api/v1/plugins?category=seo", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(1);
		expect(body.items[0]!.id).toBe("seo-plugin");
	});

	it("GET /plugins?category=forms returns empty when no plugins assigned", async () => {
		const res = await app.request("/api/v1/plugins?category=forms", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(0);
	});

	it("GET /plugins without category returns all plugins", async () => {
		const res = await app.request("/api/v1/plugins", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(2);
	});

	it("plugin detail includes categories", async () => {
		const res = await app.request("/api/v1/plugins/seo-plugin", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { categories: { slug: string; name: string }[] };
		expect(body.categories).toEqual([{ slug: "seo", name: "SEO & Metadata" }]);
	});
});

describe("FTS5 search", () => {
	let d1: ReturnType<typeof createD1Mock>;
	let env: Record<string, unknown>;

	beforeEach(() => {
		d1 = createD1Mock();
		env = makeEnv(d1);

		seedPlugin(d1._db, "seo-meta-tags", {
			name: "SEO Meta Tags",
			description: "Manage meta tags for search engines",
			keywords: ["seo", "meta", "search"],
		});
		seedPlugin(d1._db, "contact-form", {
			name: "Contact Form",
			description: "Simple contact form with email",
			keywords: ["forms", "contact", "email"],
		});
	});

	it("searches by name via FTS5", async () => {
		const res = await app.request("/api/v1/plugins?q=contact", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(1);
		expect(body.items[0]!.id).toBe("contact-form");
	});

	it("searches by description via FTS5", async () => {
		const res = await app.request("/api/v1/plugins?q=meta+tags", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(1);
		expect(body.items[0]!.id).toBe("seo-meta-tags");
	});

	it("returns empty for no matches", async () => {
		const res = await app.request("/api/v1/plugins?q=nonexistent", {}, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string }[] };
		expect(body.items.length).toBe(0);
	});

	it("sanitizes FTS5 special characters", async () => {
		// These should not cause SQL errors
		const res = await app.request("/api/v1/plugins?q=test*OR+NOT(drop)", {}, env);
		expect(res.status).toBe(200);
	});

	it("handles empty query after sanitization", async () => {
		const res = await app.request("/api/v1/plugins?q=***", {}, env);
		expect(res.status).toBe(200);
		// Falls back to LIKE with "***" pattern, returns nothing (fine)
	});
});

describe("sanitizeFtsQuery", () => {
	// Test the sanitizer indirectly through the search endpoint.
	// The function is not exported, but its behavior is observable.

	let env: Record<string, unknown>;

	beforeEach(() => {
		const d1 = createD1Mock();
		env = makeEnv(d1);
		seedPlugin(d1._db, "test-plugin", { name: "Test Plugin" });
	});

	it("strips boolean operators from queries", async () => {
		const res = await app.request("/api/v1/plugins?q=test+AND+plugin+OR+foo+NOT+bar", {}, env);
		expect(res.status).toBe(200);
		// Should not error from FTS5 syntax
	});

	it("strips special characters from queries", async () => {
		const queries = [
			'test"plugin',
			"test(plugin)",
			"test^plugin",
			"test{plugin}",
			"test[plugin]",
			"test|plugin",
			"test!plugin",
		];

		for (const q of queries) {
			const res = await app.request(`/api/v1/plugins?q=${encodeURIComponent(q)}`, {}, env);
			expect(res.status).toBe(200);
		}
	});
});
