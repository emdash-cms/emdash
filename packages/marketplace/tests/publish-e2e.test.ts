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
import { readFile, readdir } from "node:fs/promises";
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

beforeAll(async () => {
	// Build the audit-log plugin tarball
	execSync("node packages/core/dist/cli/index.mjs plugin bundle --dir packages/plugins/audit-log", {
		cwd: REPO_ROOT,
		stdio: "pipe",
	});

	const distDir = join(REPO_ROOT, "packages/plugins/audit-log/dist");
	const files = await readdir(distDir);
	const tarball = files.find((f) => f.endsWith(".tar.gz"));
	if (!tarball) throw new Error("No tarball found after bundle");
	auditLogTarball = await readFile(join(distDir, tarball));
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

	it("returns discovery config with the trimmed GitHub client id when auth is fully configured", async () => {
		env.GITHUB_CLIENT_ID = "  test-client-id\n";
		env.GITHUB_CLIENT_SECRET = "  test-secret\n";

		const res = await app.request("/api/v1/auth/discovery", {}, env);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			github: {
				enabled: boolean;
				clientId: string;
				deviceAuthorizationEndpoint: string;
				tokenEndpoint: string;
			};
			marketplace: {
				deviceTokenEndpoint: string;
			};
		};

		expect(body.github.enabled).toBe(true);
		expect(body.github.clientId).toBe("test-client-id");
		expect(body.github.deviceAuthorizationEndpoint).toBe("https://github.com/login/device/code");
		expect(body.github.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
		expect(body.marketplace.deviceTokenEndpoint).toBe("/api/v1/auth/github/device");
	});

	it("returns disabled discovery when GitHub OAuth is only partially configured", async () => {
		env.GITHUB_CLIENT_ID = "test-client-id";
		env.GITHUB_CLIENT_SECRET = "";

		const res = await app.request("/api/v1/auth/discovery", {}, env);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { github: { enabled: boolean; clientId: string } };
		expect(body.github.enabled).toBe(false);
		expect(body.github.clientId).toBe("");
	});

	it("fails device auth with 503 when GitHub OAuth config is missing", async () => {
		env.GITHUB_CLIENT_ID = "";
		env.GITHUB_CLIENT_SECRET = "";

		const res = await app.request(
			"/api/v1/auth/github/device",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ access_token: "gho_test" }),
			},
			env,
		);

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string; detail: string };
		expect(body.error).toBe("GitHub OAuth is not configured on this marketplace deployment.");
		expect(body.detail).toContain("GITHUB_CLIENT_ID");
		expect(body.detail).toContain("GITHUB_CLIENT_SECRET");
	});

	it("publishes a plugin tarball via seed auth and lists it", async () => {
		const formData = new FormData();
		formData.append(
			"bundle",
			new Blob([auditLogTarball], { type: "application/gzip" }),
			"audit-log-0.1.0.tar.gz",
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
		expect(publishBody.version).toBe("0.1.0");
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
		expect(versionBody.items[0]!.version).toBe("0.1.0");
		expect(versionBody.items[0]!.status).toBe("published");
	});

	it("re-publishes same version idempotently via seed auth", async () => {
		const makeFormData = () => {
			const fd = new FormData();
			fd.append(
				"bundle",
				new Blob([auditLogTarball], { type: "application/gzip" }),
				"audit-log-0.1.0.tar.gz",
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
			"audit-log-0.1.0.tar.gz",
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
			"audit-log-0.1.0.tar.gz",
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
