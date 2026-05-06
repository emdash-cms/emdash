/**
 * E2E tests for plugin publishing flow.
 *
 * Runs the real Hono app with:
 * - better-sqlite3 as a D1 mock
 * - In-memory Map as R2 mock
 * - Seed token auth (skips audit, publishes immediately)
 *
 * Tests the full path: tarball upload -> manifest validation -> DB write -> R2 store -> public API listing
 */

import { execSync } from "node:child_process";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Polyfill crypto.subtle.timingSafeEqual (Workers API not in Node)
const subtle = crypto.subtle as unknown as Record<string, unknown>;
if (!subtle.timingSafeEqual) {
	subtle.timingSafeEqual = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
		return nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b));
	};
}

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

// ── R2 mock ────────────────────────────────────────────────────

function createR2Mock() {
	const store = new Map<string, { data: ArrayBuffer; metadata?: Record<string, string> }>();
	return {
		async put(
			key: string,
			data: ArrayBuffer | Uint8Array | ReadableStream,
			opts?: { httpMetadata?: { contentType?: string } },
		) {
			let buf: ArrayBuffer;
			if (data instanceof ArrayBuffer) {
				buf = data;
			} else if (ArrayBuffer.isView(data)) {
				buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
			} else {
				const reader = (data as ReadableStream<Uint8Array>).getReader();
				const chunks: Uint8Array[] = [];
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value) chunks.push(value);
				}
				const total = chunks.reduce((acc, c) => acc + c.length, 0);
				const merged = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					merged.set(chunk, offset);
					offset += chunk.length;
				}
				buf = merged.buffer as ArrayBuffer;
			}
			store.set(key, { data: buf, metadata: opts?.httpMetadata });
		},
		async get(key: string) {
			const entry = store.get(key);
			if (!entry) return null;
			return {
				arrayBuffer: async () => entry.data,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(entry.data));
						controller.close();
					},
				}),
			};
		},
		async head(key: string) {
			return store.has(key) ? { size: store.get(key)!.data.byteLength } : null;
		},
		_store: store,
	};
}

// ── Test fixtures ──────────────────────────────────────────────

const RE_EXTRACT_OR_TARBALL = /extract|tarball/i;
const SEED_TOKEN = "test-seed-token-for-e2e";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

let auditLogTarball: Buffer;
let auditLogVersion: string;

beforeAll(async () => {
	// Build the audit-log plugin tarball
	execSync("node packages/core/dist/cli/index.mjs plugin bundle --dir packages/plugins/audit-log", {
		cwd: REPO_ROOT,
		stdio: "pipe",
	});

	const auditLogPkg = JSON.parse(
		readFileSync(join(REPO_ROOT, "packages/plugins/audit-log/package.json"), "utf-8"),
	) as { version: string };
	auditLogVersion = auditLogPkg.version;

	const distDir = join(REPO_ROOT, "packages/plugins/audit-log/dist");
	const tarballName = `audit-log-${auditLogVersion}.tar.gz`;
	auditLogTarball = await readFile(join(distDir, tarballName));
}, 30000);

// ── Tests ──────────────────────────────────────────────────────

describe("marketplace publish e2e", () => {
	let env: Record<string, unknown>;

	beforeEach(() => {
		env = {
			DB: createD1Mock(),
			R2: createR2Mock(),
			SEED_TOKEN,
			GITHUB_CLIENT_ID: "test",
			GITHUB_CLIENT_SECRET: "test-secret",
			AUDIT_ENFORCEMENT: "none",
		};
	});

	it("publishes a plugin tarball via seed auth and lists it", async () => {
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([auditLogTarball], { type: "application/gzip" }),
			`audit-log-${auditLogVersion}.tar.gz`,
		);

		const publishRes = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${SEED_TOKEN}` },
				body: formData,
			},
			env,
		);

		expect(publishRes.status).toBe(201);
		const publishBody = (await publishRes.json()) as Record<string, unknown>;
		expect(publishBody.version).toBe(auditLogVersion);
		expect(publishBody.status).toBe("published");
		expect(publishBody.checksum).toBeTruthy();

		// Verify the plugin is listed
		const listRes = await app.request("/api/v1/plugins", {}, env);
		expect(listRes.status).toBe(200);
		const listBody = (await listRes.json()) as { items: { id: string }[] };
		expect(listBody.items).toHaveLength(1);
		expect(listBody.items[0]!.id).toBe("audit-log");

		// Verify the specific plugin endpoint
		const detailRes = await app.request("/api/v1/plugins/audit-log", {}, env);
		expect(detailRes.status).toBe(200);
		const detailBody = (await detailRes.json()) as { id: string };
		expect(detailBody.id).toBe("audit-log");

		// Verify the version endpoint
		const versionRes = await app.request("/api/v1/plugins/audit-log/versions", {}, env);
		expect(versionRes.status).toBe(200);
		const versionBody = (await versionRes.json()) as {
			items: { version: string; status: string }[];
		};
		expect(versionBody.items).toHaveLength(1);
		expect(versionBody.items[0]!.version).toBe(auditLogVersion);
		expect(versionBody.items[0]!.status).toBe("published");
	});

	it("re-publishes same version idempotently via seed auth", async () => {
		const makeFormData = () => {
			const fd = new FormData();
			fd.append(
				"bundle",
				new Blob([auditLogTarball], { type: "application/gzip" }),
				`audit-log-${auditLogVersion}.tar.gz`,
			);
			return fd;
		};

		// First publish
		const res1 = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${SEED_TOKEN}` },
				body: makeFormData(),
			},
			env,
		);
		expect(res1.status).toBe(201);

		// Re-publish same version
		const res2 = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${SEED_TOKEN}` },
				body: makeFormData(),
			},
			env,
		);
		expect(res2.status).toBe(201);

		// Still only one version
		const versionRes = await app.request("/api/v1/plugins/audit-log/versions", {}, env);
		const body = (await versionRes.json()) as { items: unknown[] };
		expect(body.items).toHaveLength(1);
	});

	it("rejects publish without auth", async () => {
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([auditLogTarball], { type: "application/gzip" }),
			`audit-log-${auditLogVersion}.tar.gz`,
		);

		const res = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{ method: "POST", body: formData },
			env,
		);
		expect(res.status).toBe(401);
	});

	it("rejects invalid tarball", async () => {
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([new Uint8Array([1, 2, 3])], { type: "application/gzip" }),
			"bad.tar.gz",
		);

		const res = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{
				method: "POST",
				headers: { Authorization: `Bearer ${SEED_TOKEN}` },
				body: formData,
			},
			env,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(RE_EXTRACT_OR_TARBALL);
	});

	it("rejects wrong seed token", async () => {
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([auditLogTarball], { type: "application/gzip" }),
			`audit-log-${auditLogVersion}.tar.gz`,
		);

		const res = await app.request(
			"/api/v1/plugins/audit-log/versions",
			{
				method: "POST",
				headers: { Authorization: "Bearer wrong-token" },
				body: formData,
			},
			env,
		);
		expect(res.status).toBe(401);
	});
});
