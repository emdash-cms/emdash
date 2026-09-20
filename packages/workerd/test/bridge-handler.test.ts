/**
 * Bridge Handler Conformance Tests
 *
 * Tests the shared bridge handler that both the production (workerd)
 * and dev (miniflare) runners use. This is the conformance test suite
 * that ensures identical behavior across all sandbox runners.
 *
 * These tests exercise capability enforcement, KV isolation, and
 * error handling at the bridge level.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	bytesOverLimit,
	INVALID_PLUGIN_HTTP_BYTES,
} from "../../core/tests/fixtures/plugin-http.js";
import { createBridgeHandler, type BridgeHandlerOptions } from "../src/sandbox/bridge-handler.js";

// Set up an in-memory SQLite database with the minimum tables needed
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function setupTables(db: Kysely<any>) {
	// Plugin storage table (used for both KV and document storage)
	await db.schema
		.createTable("_plugin_storage")
		.addColumn("plugin_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("id", "text", (col) => col.notNull())
		.addColumn("data", "text", (col) => col.notNull())
		.addColumn("revision", "text", (col) => col.notNull().defaultTo("0"))
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
		.execute();

	await db.schema
		.createTable("options")
		.addColumn("name", "text", (col) => col.primaryKey())
		.addColumn("value", "text", (col) => col.notNull())
		.addColumn("revision", "text", (col) => col.notNull())
		.execute();

	// Users table (matches migration 001)
	await db.schema
		.createTable("users")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();

	await db.schema
		.createTable("_emdash_comments")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("content_id", "text", (col) => col.notNull())
		.addColumn("parent_id", "text")
		.addColumn("author_name", "text", (col) => col.notNull())
		.addColumn("author_email", "text", (col) => col.notNull())
		.addColumn("author_user_id", "text")
		.addColumn("body", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("ip_hash", "text")
		.addColumn("user_agent", "text")
		.addColumn("moderation_metadata", "text")
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.execute();

	// Insert a test user
	await db
		.insertInto("users" as any)
		.values({
			id: "user-1",
			email: "test@example.com",
			name: "Test User",
			role: 50,
			created_at: new Date().toISOString(),
		})
		.execute();
}

describe("Bridge Handler Conformance", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;

	beforeEach(async () => {
		const ctx = createTestDb();
		db = ctx.db;
		sqlite = ctx.sqlite;
		await setupTables(db);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await db.destroy();
		sqlite.close();
	});

	function makeHandler(opts: {
		pluginId?: string;
		capabilities?: string[];
		allowedHosts?: string[];
		storageCollections?: string[];
		beforeContentWrite?: () => Promise<void>;
		settingsSchema?: Record<string, { type: "secret"; label: string }>;
		commentModerate?: () => (
			pluginId: string,
			id: string,
			status: "approved" | "pending" | "spam",
			expectedStatus: "approved" | "pending" | "spam",
		) => Promise<unknown>;
		taxonomyWrite?: BridgeHandlerOptions["taxonomyWrite"];
		contentActions?: BridgeHandlerOptions["contentActions"];
	}) {
		return createBridgeHandler({
			pluginId: opts.pluginId ?? "test-plugin",
			version: "1.0.0",
			capabilities: opts.capabilities ?? [],
			allowedHosts: opts.allowedHosts ?? [],
			storageCollections: opts.storageCollections ?? [],
			db,
			emailSend: () => null,
			beforeContentWrite: opts.beforeContentWrite,
			settingsSchema: opts.settingsSchema,
			commentModerate: opts.commentModerate,
			taxonomyWrite: opts.taxonomyWrite,
			contentActions: opts.contentActions,
		});
	}

	async function call(
		handler: ReturnType<typeof makeHandler>,
		method: string,
		body: Record<string, unknown> = {},
	) {
		const request = new Request(`http://bridge/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const response = await handler(request);
		return response.json() as Promise<{ result?: unknown; error?: string }>;
	}

	describe("publication actions", () => {
		it("routes capability-gated actions through the host callback", async () => {
			const versioned = {
				item: {
					id: "post-1",
					type: "posts",
					slug: "post-1",
					status: "draft",
					locale: "en",
					data: {},
					createdAt: "2030-01-01T00:00:00.000Z",
					updatedAt: "2030-01-01T00:00:00.000Z",
					publishedAt: null,
				},
				_rev: "revision-2",
			};
			const actions = {
				flush: vi.fn().mockResolvedValue(undefined),
				getVersioned: vi.fn().mockResolvedValue(versioned),
				publish: vi.fn().mockResolvedValue(versioned),
				unpublish: vi.fn().mockResolvedValue(versioned),
				schedule: vi.fn().mockResolvedValue(versioned),
				unschedule: vi.fn().mockResolvedValue(versioned),
				getTrashedVersioned: vi.fn().mockResolvedValue(versioned),
				restore: vi.fn().mockResolvedValue(versioned),
			};
			const handler = makeHandler({
				capabilities: ["content:publish", "content:restore"],
				contentActions: () => actions,
			});

			await expect(
				call(handler, "content/publish", {
					collection: "posts",
					id: "post-1",
					revision: "revision-1",
				}),
			).resolves.toEqual({ result: versioned });
			expect(actions.publish).toHaveBeenCalledWith(
				"test-plugin",
				"posts",
				"post-1",
				{
					_rev: "revision-1",
				},
				undefined,
			);
			actions.publish.mockRejectedValueOnce(
				Object.assign(new Error("Revision precondition did not match"), { code: "CONFLICT" }),
			);
			await expect(
				call(handler, "content/publish", {
					collection: "posts",
					id: "post-1",
					revision: "stale",
				}),
			).resolves.toEqual({
				result: {
					__emdashContentActionError: true,
					error: { code: "CONFLICT", message: "Revision precondition did not match" },
				},
			});

			const denied = makeHandler({ capabilities: [], contentActions: () => actions });
			await expect(
				call(denied, "content/restore", {
					collection: "posts",
					id: "post-1",
					revision: "revision-1",
				}),
			).resolves.toMatchObject({ error: "Missing capability: content:restore" });
		});
	});

	// ── KV Operations ────────────────────────────────────────────────────

	describe("KV operations", () => {
		it("shares encrypted settings with the compatibility KV alias", async () => {
			vi.stubEnv(
				"EMDASH_ENCRYPTION_KEY",
				"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			);
			const handler = makeHandler({
				settingsSchema: { apiKey: { type: "secret", label: "API key" } },
			});
			await call(handler, "settings/set", { key: "apiKey", value: "workerd-secret" });

			expect((await call(handler, "settings/get", { key: "apiKey" })).result).toBe(
				"workerd-secret",
			);
			expect((await call(handler, "kv/get", { key: "settings:apiKey" })).result).toBe(
				"workerd-secret",
			);
			const stored = await db
				.selectFrom("options" as any)
				.select("value" as any)
				.where("name" as any, "=", "plugin:test-plugin:settings:apiKey")
				.executeTakeFirst();
			expect(stored?.value).not.toContain("workerd-secret");
			expect(JSON.parse(stored!.value)).toMatchObject({ v: 1, kid: expect.any(String) });
			const infoLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
			await call(handler, "log", {
				level: "info",
				msg: "credential=workerd-secret",
				data: { token: "workerd-secret" },
			});
			expect(JSON.stringify(infoLog.mock.calls)).toContain("[REDACTED]");
			expect(JSON.stringify(infoLog.mock.calls)).not.toContain("workerd-secret");
		});

		it("fails closed without an encryption key and redacts the submitted secret", async () => {
			vi.stubEnv("EMDASH_ENCRYPTION_KEY", "");
			const handler = makeHandler({
				settingsSchema: { apiKey: { type: "secret", label: "API key" } },
			});
			const result = await call(handler, "settings/set", {
				key: "apiKey",
				value: "must-not-appear",
			});
			expect(result.error).toMatch(/EMDASH_ENCRYPTION_KEY/);
			expect(JSON.stringify(result)).not.toContain("must-not-appear");
		});

		it("reads and writes admin-managed settings through ctx.kv", async () => {
			await db
				.insertInto("options" as any)
				.values({
					name: "plugin:test-plugin:settings:enabled",
					value: JSON.stringify(false),
					revision: "settings-revision",
				})
				.execute();
			const handler = makeHandler({});

			expect((await call(handler, "kv/get", { key: "settings:enabled" })).result).toBe(false);
			await call(handler, "kv/set", { key: "settings:enabled", value: true });

			expect(
				await db
					.selectFrom("options" as any)
					.select("value" as any)
					.where("name" as any, "=", "plugin:test-plugin:settings:enabled")
					.executeTakeFirst(),
			).toEqual({ value: JSON.stringify(true) });
		});
		it("set and get a value", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "test", value: "hello" });
			const result = await call(handler, "kv/get", { key: "test" });
			expect(result.result).toBe("hello");
		});

		it("escapes reserved byte marker objects in bridge responses", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", {
				key: "marker",
				value: { __emdashBytes: "ordinary" },
			});

			const result = await call(handler, "kv/get", { key: "marker" });
			expect(result.result).toEqual({
				__emdashEscapedObject: [["__emdashBytes", "ordinary"]],
			});
		});

		it("get returns null for non-existent key", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "kv/get", { key: "missing" });
			expect(result.result).toBeNull();
		});

		it("delete removes a key", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "to-delete", value: "bye" });
			await call(handler, "kv/delete", { key: "to-delete" });
			const result = await call(handler, "kv/get", { key: "to-delete" });
			expect(result.result).toBeNull();
		});

		it("list returns keys with prefix", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "settings:theme", value: "dark" });
			await call(handler, "kv/set", { key: "settings:lang", value: "en" });
			await call(handler, "kv/set", { key: "state:count", value: 42 });

			const result = await call(handler, "kv/list", { prefix: "settings:" });
			const items = result.result as Array<{ key: string; value: unknown }>;
			expect(items).toHaveLength(2);
			expect(items.map((i) => i.key).toSorted()).toEqual(["settings:lang", "settings:theme"]);
		});

		it("KV is scoped per plugin (isolation)", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});

			// Plugin A sets a value
			await call(handlerA, "kv/set", { key: "secret", value: "a-data" });

			// Plugin B cannot see it
			const resultB = await call(handlerB, "kv/get", { key: "secret" });
			expect(resultB.result).toBeNull();

			// Plugin A can see it
			const resultA = await call(handlerA, "kv/get", { key: "secret" });
			expect(resultA.result).toBe("a-data");
		});
	});

	it("scopes cron scheduling to the sandboxed plugin", async () => {
		await db.schema
			.createTable("_emdash_cron_tasks")
			.addColumn("id", "text", (col) => col.primaryKey())
			.addColumn("plugin_id", "text", (col) => col.notNull())
			.addColumn("task_name", "text", (col) => col.notNull())
			.addColumn("schedule", "text", (col) => col.notNull())
			.addColumn("is_oneshot", "integer", (col) => col.notNull())
			.addColumn("data", "text")
			.addColumn("next_run_at", "text", (col) => col.notNull())
			.addColumn("last_run_at", "text")
			.addColumn("status", "text", (col) => col.notNull())
			.addColumn("locked_at", "text")
			.addColumn("enabled", "integer", (col) => col.notNull())
			.addUniqueConstraint("uq_cron_plugin_task", ["plugin_id", "task_name"])
			.execute();
		const reschedule = vi.fn();
		const handler = createBridgeHandler({
			pluginId: "cron-plugin",
			version: "1.0.0",
			capabilities: [],
			allowedHosts: [],
			storageCollections: [],
			db,
			emailSend: () => null,
			cronReschedule: reschedule,
		});

		await call(handler, "cron/schedule", {
			name: "daily",
			schedule: "@daily",
			data: { source: "sandbox" },
		});
		const result = await call(handler, "cron/list");

		expect(result.result).toEqual([expect.objectContaining({ name: "daily", schedule: "@daily" })]);
		expect(reschedule).toHaveBeenCalledOnce();
		expect(
			await db
				.selectFrom("_emdash_cron_tasks" as any)
				.select("plugin_id" as any)
				.executeTakeFirst(),
		).toMatchObject({ plugin_id: "cron-plugin" });
	});

	describe.each(["kv", "storage"] as const)("%s conditional operations", (kind) => {
		const keyFields = (key: string) =>
			kind === "kv" ? { key } : { collection: "records", id: key };
		const valueFields = (value: unknown) => (kind === "kv" ? { value } : { data: value });
		const writeMethod = kind === "kv" ? "set" : "put";

		async function readRevision(handler: ReturnType<typeof makeHandler>, key: string) {
			const result = await call(handler, `${kind}/getVersioned`, keyFields(key));
			const value = result.result;
			if (
				!value ||
				typeof value !== "object" ||
				!("revision" in value) ||
				typeof value.revision !== "string"
			) {
				throw new Error(`Expected a versioned value: ${JSON.stringify(result)}`);
			}
			return value.revision;
		}

		it("allows one concurrent creator, replacement, and deletion for an exact key", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			const create = await Promise.all(
				["first", "second"].map((value) =>
					call(handler, `${kind}/compareAndSet`, {
						...keyFields("job"),
						expectedRevision: null,
						...valueFields(value),
					}),
				),
			);
			expect(
				create.filter(
					(result) =>
						result.result &&
						typeof result.result === "object" &&
						"applied" in result.result &&
						result.result.applied === true,
				),
			).toHaveLength(1);
			const revision = await readRevision(handler, "job");
			const replace = await Promise.all(
				["next", "later"].map((value) =>
					call(handler, `${kind}/compareAndSet`, {
						...keyFields("job"),
						expectedRevision: revision,
						...valueFields(value),
					}),
				),
			);
			expect(
				replace.filter(
					(result) =>
						result.result &&
						typeof result.result === "object" &&
						"applied" in result.result &&
						result.result.applied === true,
				),
			).toHaveLength(1);
			const updatedRevision = await readRevision(handler, "job");
			expect(updatedRevision).not.toBe(revision);
			const remove = await Promise.all(
				[0, 1].map(() =>
					call(handler, `${kind}/compareAndDelete`, {
						...keyFields("job"),
						expectedRevision: updatedRevision,
					}),
				),
			);
			expect(remove).toContainEqual({ result: { applied: true } });
			expect(remove).toContainEqual({ result: { applied: false } });
			expect(await call(handler, `${kind}/getVersioned`, keyFields("job"))).toEqual({
				result: null,
			});
			await call(handler, `${kind}/compareAndSet`, {
				...keyFields("job"),
				expectedRevision: null,
				...valueFields(null),
			});
			expect(await readRevision(handler, "job")).not.toBe(updatedRevision);
			expect(
				await call(handler, `${kind}/compareAndDelete`, {
					...keyFields("job"),
					expectedRevision: updatedRevision,
				}),
			).toEqual({ result: { applied: false } });
			expect(await call(handler, `${kind}/getVersioned`, keyFields("job"))).toEqual({
				result: { value: null, revision: expect.any(String) },
			});
		});

		it("invalidates a revision after an ordinary same-value write", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			await call(handler, `${kind}/${writeMethod}`, {
				...keyFields("settings"),
				...valueFields(false),
			});
			const revision = await readRevision(handler, "settings");
			await call(handler, `${kind}/${writeMethod}`, {
				...keyFields("settings"),
				...valueFields(false),
			});
			expect(await readRevision(handler, "settings")).not.toBe(revision);
			expect(
				await call(handler, `${kind}/compareAndSet`, {
					...keyFields("settings"),
					expectedRevision: revision,
					...valueFields(true),
				}),
			).toEqual({ result: { applied: false } });
		});

		it("rejects invalid keys, revisions, and oversized values without writing", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			for (const key of ["", "x".repeat(1025)]) {
				expect((await call(handler, `${kind}/getVersioned`, keyFields(key))).error).toBeDefined();
			}
			for (const expectedRevision of [undefined, 1, {}, "", "r".repeat(129)]) {
				expect(
					(
						await call(handler, `${kind}/compareAndSet`, {
							...keyFields("invalid"),
							expectedRevision,
							...valueFields("value"),
						})
					).error,
				).toBeDefined();
			}
			expect(
				(
					await call(handler, `${kind}/compareAndDelete`, {
						...keyFields("invalid"),
						expectedRevision: null,
					})
				).error,
			).toBeDefined();
			expect(
				(
					await call(handler, `${kind}/compareAndSet`, {
						...keyFields("invalid"),
						expectedRevision: null,
						...valueFields("x".repeat(1024 * 1024)),
					})
				).error,
			).toBeDefined();
			expect(await call(handler, `${kind}/getVersioned`, keyFields("invalid"))).toEqual({
				result: null,
			});
		});

		it("keeps revisions scoped to the authenticated plugin and exact key", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			const other = makeHandler({ pluginId: "other-plugin", storageCollections: ["records"] });
			for (const target of [handler, other]) {
				await call(target, `${kind}/${writeMethod}`, {
					...keyFields("shared"),
					...valueFields("original"),
				});
			}
			const revision = await readRevision(handler, "shared");
			expect(
				await call(other, `${kind}/compareAndSet`, {
					...keyFields("shared"),
					pluginId: "test-plugin",
					expectedRevision: revision,
					...valueFields("changed"),
				}),
			).toEqual({ result: { applied: false } });
			expect(
				await call(handler, `${kind}/compareAndSet`, {
					...keyFields("different"),
					expectedRevision: revision,
					...valueFields("changed"),
				}),
			).toEqual({ result: { applied: false } });
			expect(await call(other, `${kind}/get`, keyFields("shared"))).toEqual({ result: "original" });
		});
	});

	it("guards declared collections for all conditional operations and advances bulk-write revisions", async () => {
		const handler = makeHandler({ storageCollections: ["records"] });
		for (const method of ["getVersioned", "compareAndSet", "compareAndDelete"]) {
			expect(
				(
					await call(handler, `storage/${method}`, {
						collection: "undeclared",
						id: "job",
						expectedRevision: null,
						data: "value",
					})
				).error,
			).toContain("Storage collection not declared");
		}
		await call(handler, "storage/put", { collection: "records", id: "job", data: 0 });
		const before = await call(handler, "storage/getVersioned", {
			collection: "records",
			id: "job",
		});
		await call(handler, "storage/putMany", {
			collection: "records",
			items: [{ id: "job", data: 0 }],
		});
		const after = await call(handler, "storage/getVersioned", { collection: "records", id: "job" });
		expect(after.result).toMatchObject({ value: 0, revision: expect.any(String) });
		expect(after.result).not.toEqual(before.result);
	});

	// ── Capability Enforcement ────────────────────────────────────────────

	describe("capability enforcement", () => {
		it("gates comment reads and moderation independently", async () => {
			const denied = makeHandler({ capabilities: [] });
			await expect(call(denied, "comments/get", { id: "comment-1" })).resolves.toMatchObject({
				error: expect.stringContaining("Missing capability: comments:read"),
			});

			const readOnly = makeHandler({ capabilities: ["comments:read"] });
			await expect(
				call(readOnly, "comments/setStatus", {
					id: "comment-1",
					status: "approved",
					expectedStatus: "pending",
				}),
			).resolves.toMatchObject({
				error: expect.stringContaining("Missing capability: comments:moderate"),
			});

			const moderate = vi.fn();
			const invalid = makeHandler({
				capabilities: ["comments:read", "comments:moderate"],
				commentModerate: () => moderate,
			});
			await expect(
				call(invalid, "comments/setStatus", {
					id: "comment-1",
					status: "trash",
					expectedStatus: "pending",
				}),
			).resolves.toEqual({
				error: {
					code: "COMMENT_STATUS_INVALID",
					message: "status must be one of: approved, pending, spam",
				},
			});
			expect(moderate).not.toHaveBeenCalled();
		});

		it("round-trips comment personal data and expected-status moderation", async () => {
			const now = new Date().toISOString();
			await db
				.insertInto("_emdash_comments" as never)
				.values({
					id: "comment-1",
					collection: "posts",
					content_id: "post-1",
					parent_id: null,
					author_name: "Reader",
					author_email: "reader@example.com",
					author_user_id: "user-1",
					body: "Hello",
					status: "pending",
					ip_hash: "sha256:reader",
					user_agent: "Test/1.0",
					moderation_metadata: '{"score":2}',
					created_at: now,
					updated_at: now,
				} as never)
				.execute();
			const moderate = vi.fn(async (_pluginId, id, status, expectedStatus) => ({
				id,
				status,
				expectedStatus,
			}));
			const handler = makeHandler({
				capabilities: ["comments:moderate", "comments:read"],
				commentModerate: () => moderate,
			});

			const read = await call(handler, "comments/get", { id: "comment-1" });
			expect(read.result).toMatchObject({
				authorEmail: "reader@example.com",
				body: "Hello",
				ipHash: "sha256:reader",
				userAgent: "Test/1.0",
				moderationMetadata: { score: 2 },
			});
			expect(read.result).not.toHaveProperty("authorUserId");
			await call(handler, "comments/setStatus", {
				id: "comment-1",
				status: "approved",
				expectedStatus: "pending",
			});
			expect(moderate).toHaveBeenCalledWith("test-plugin", "comment-1", "approved", "pending");

			const conflict = makeHandler({
				capabilities: ["comments:moderate", "comments:read"],
				commentModerate: () => async () => {
					throw Object.assign(new Error("Comment status changed"), {
						code: "COMMENT_STATUS_CONFLICT",
						currentStatus: "approved",
					});
				},
			});
			await expect(
				call(conflict, "comments/setStatus", {
					id: "comment-1",
					status: "spam",
					expectedStatus: "pending",
				}),
			).resolves.toEqual({
				error: {
					code: "COMMENT_STATUS_CONFLICT",
					message: "Comment status changed",
					currentStatus: "approved",
				},
			});
		});
		it("separately denies schema and revision history reads", async () => {
			const handler = makeHandler({ capabilities: ["content:read"] });
			expect((await call(handler, "schema/listCollections")).error).toContain(
				"Missing capability: schema:read",
			);
			expect(
				(
					await call(handler, "content/listRevisions", {
						collection: "posts",
						id: "123",
					})
				).error,
			).toContain("Missing capability: content:revisions:read");
		});

		it("rejects content read without content:read capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toContain("Missing capability: content:read");
		});

		it("allows content read with the canonical content:read capability", async () => {
			// Create a content table first
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["content:read"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			// No error, returns null (post doesn't exist)
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("returns the typed content shape and honors list filters and ordering", async () => {
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("slug", "text")
				.addColumn("status", "text", (col) => col.notNull())
				.addColumn("locale", "text")
				.addColumn("title", "text")
				.addColumn("created_at", "text", (col) => col.notNull())
				.addColumn("updated_at", "text", (col) => col.notNull())
				.addColumn("published_at", "text")
				.addColumn("scheduled_at", "text")
				.addColumn("deleted_at", "text")
				.execute();
			await db.schema
				.createTable("_emdash_collections")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("slug", "text", (col) => col.notNull())
				.addColumn("has_seo", "integer", (col) => col.notNull())
				.execute();
			await db.schema
				.createTable("_emdash_seo")
				.addColumn("collection", "text", (col) => col.notNull())
				.addColumn("content_id", "text", (col) => col.notNull())
				.addColumn("seo_title", "text")
				.addColumn("seo_description", "text")
				.addColumn("seo_image", "text")
				.addColumn("seo_canonical", "text")
				.addColumn("seo_no_index", "integer", (col) => col.notNull())
				.addPrimaryKeyConstraint("pk_seo", ["collection", "content_id"])
				.execute();
			await db
				.insertInto("_emdash_collections" as any)
				.values({ id: "posts", slug: "posts", has_seo: 1 })
				.execute();
			const now = new Date().toISOString();
			await db
				.insertInto("ec_posts" as any)
				.values([
					{
						id: "post-a",
						slug: "a",
						status: "draft",
						locale: "en",
						title: "A",
						created_at: now,
						updated_at: now,
						published_at: null,
						scheduled_at: null,
						deleted_at: null,
					},
					{
						id: "post-b",
						slug: "b",
						status: "published",
						locale: "en",
						title: "B",
						created_at: now,
						updated_at: now,
						published_at: now,
						scheduled_at: null,
						deleted_at: null,
					},
				])
				.execute();
			await db
				.insertInto("_emdash_seo" as any)
				.values({
					collection: "posts",
					content_id: "post-b",
					seo_title: "SEO B",
					seo_description: null,
					seo_image: null,
					seo_canonical: null,
					seo_no_index: 0,
				})
				.execute();

			const handler = makeHandler({ capabilities: ["content:read"] });
			const result = await call(handler, "content/list", {
				collection: "posts",
				where: { status: "published" },
				orderBy: { slug: "asc" },
			});
			const list = result.result as { items: Array<Record<string, unknown>> };

			expect(list.items).toHaveLength(1);
			expect(list.items[0]).toMatchObject({
				id: "post-b",
				slug: "b",
				status: "published",
				publishedAt: now,
				scheduledAt: null,
				seo: { title: "SEO B" },
			});
		});

		it("allows content reads through the content:write implication", async () => {
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["write:content"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toBeUndefined();
		});

		it("rejects taxonomy read without taxonomies:read capability", async () => {
			// content:read does not grant taxonomy access — it's a separate
			// capability (and a new one, so the canonical name is checked).
			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "taxonomy/list", {});
			expect(result.error).toContain("Missing capability: taxonomies:read");
		});

		it("enforces taxonomy write and delegates mutations to the runtime surface", async () => {
			const createTerm = vi.fn(async () => ({
				id: "term-2",
				taxonomy: "genre",
				slug: "reviews",
				label: "Reviews",
				parentId: null,
				data: null,
				locale: "en",
				translationGroup: "term-2",
			}));
			const taxonomyWrite = {
				getAll: vi.fn(async () => []),
				getTerms: vi.fn(async () => []),
				getEntryTerms: vi.fn(async () => []),
				createTerm,
				addEntryTerms: vi.fn(async () => []),
				removeEntryTerms: vi.fn(async () => []),
			};
			const reader = makeHandler({ capabilities: ["taxonomies:read"], taxonomyWrite });
			expect(
				(
					await call(reader, "taxonomy/createTerm", {
						taxonomy: "genre",
						input: { label: "Reviews" },
					})
				).error,
			).toContain("Missing capability: taxonomies:write");

			const writer = makeHandler({ capabilities: ["taxonomies:write"], taxonomyWrite });
			const result = await call(writer, "taxonomy/createTerm", {
				taxonomy: "genre",
				input: { label: "Reviews" },
			});
			expect(result.error).toBeUndefined();
			expect(createTerm).toHaveBeenCalledWith("genre", { label: "Reviews" });
		});

		it("allows taxonomy read with implied access from taxonomies:write", async () => {
			await db.schema
				.createTable("_emdash_taxonomy_defs")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("name", "text", (col) => col.notNull())
				.addColumn("label", "text", (col) => col.notNull())
				.addColumn("label_singular", "text")
				.addColumn("hierarchical", "integer", (col) => col.notNull().defaultTo(0))
				.addColumn("collections", "text")
				.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
				.addColumn("translation_group", "text")
				.execute();
			await db
				.insertInto("_emdash_taxonomy_defs" as any)
				.values({
					id: "def-genre",
					name: "genre",
					label: "Genres",
					label_singular: "Genre",
					hierarchical: 1,
					collections: '["posts"]',
					locale: "en",
					translation_group: "def-genre",
				})
				.execute();

			const handler = makeHandler({ capabilities: ["taxonomies:write"] });
			const result = await call(handler, "taxonomy/list", {});
			expect(result.error).toBeUndefined();
			const defs = result.result as Array<{ name: string; hierarchical: boolean }>;
			expect(defs).toHaveLength(1);
			expect(defs[0]).toMatchObject({ name: "genre", hierarchical: true, collections: ["posts"] });
		});

		it("resolves taxonomy terms and entry terms through the pivot join", async () => {
			await db.schema
				.createTable("taxonomies")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("name", "text", (col) => col.notNull())
				.addColumn("slug", "text", (col) => col.notNull())
				.addColumn("label", "text", (col) => col.notNull())
				.addColumn("parent_id", "text")
				.addColumn("data", "text")
				.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
				.addColumn("translation_group", "text")
				.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
				.execute();
			await db.schema
				.createTable("content_taxonomies")
				.addColumn("collection", "text", (col) => col.notNull())
				.addColumn("entry_id", "text", (col) => col.notNull())
				.addColumn("taxonomy_id", "text", (col) => col.notNull())
				.execute();
			await db
				.insertInto("taxonomies" as any)
				.values([
					{
						id: "term-en",
						name: "genre",
						slug: "scifi",
						label: "Sci-Fi",
						data: '{"description":"Space"}',
						locale: "en",
						translation_group: "tg-scifi",
						sort_order: 0,
					},
					{
						id: "term-de",
						name: "genre",
						slug: "scifi",
						label: "Science-Fiction",
						locale: "de",
						translation_group: "tg-scifi",
						// Same group as term-en, so the same position.
						sort_order: 0,
					},
					{
						id: "term-other",
						name: "genre",
						slug: "fantasy",
						label: "Fantasy",
						locale: "en",
						translation_group: "tg-fantasy",
						// Placed after Sci-Fi by hand, against its label — so the
						// assertion below fails if the manual order stops leading.
						sort_order: 1,
					},
				])
				.execute();
			// The pivot stores the term's translation_group, not a row id.
			await db
				.insertInto("content_taxonomies" as any)
				.values({ collection: "posts", entry_id: "post-1", taxonomy_id: "tg-scifi" })
				.execute();

			const denied = makeHandler({ capabilities: ["read:content"] });
			expect((await call(denied, "taxonomy/terms", { taxonomy: "genre" })).error).toContain(
				"Missing capability: taxonomies:read",
			);
			expect(
				(await call(denied, "taxonomy/entryTerms", { collection: "posts", entryId: "post-1" }))
					.error,
			).toContain("Missing capability: taxonomies:read");

			const handler = makeHandler({ capabilities: ["taxonomies:read"] });

			// terms: locale filter + data JSON parsing + translation group
			const terms = await call(handler, "taxonomy/terms", { taxonomy: "genre", locale: "en" });
			expect(terms.error).toBeUndefined();
			const termRows = terms.result as Array<Record<string, unknown>>;
			expect(termRows.map((t) => t.slug)).toEqual(["scifi", "fantasy"]);
			expect(termRows[0]).toMatchObject({
				id: "term-en",
				data: { description: "Space" },
				translationGroup: "tg-scifi",
			});

			// entryTerms: pivot join on translation_group resolves both locales
			const entryTerms = await call(handler, "taxonomy/entryTerms", {
				collection: "posts",
				entryId: "post-1",
			});
			expect(entryTerms.error).toBeUndefined();
			const entryRows = entryTerms.result as Array<Record<string, unknown>>;
			expect(entryRows.map((t) => t.id)).toEqual(["term-de", "term-en"]);

			// entryTerms: locale narrows to one row per assignment
			const localized = await call(handler, "taxonomy/entryTerms", {
				collection: "posts",
				entryId: "post-1",
				locale: "de",
			});
			expect((localized.result as unknown[]).length).toBe(1);
		});

		it("rejects user read without users:read capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toContain("Missing capability: users:read");
		});

		it("allows user read with read:users", async () => {
			const handler = makeHandler({ capabilities: ["read:users"] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toBeUndefined();
			const user = result.result as { id: string; email: string };
			expect(user.id).toBe("user-1");
			expect(user.email).toBe("test@example.com");
		});

		it("rejects network fetch without network:request capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "http/fetch", {
				url: "https://example.com",
			});
			expect(result.error).toContain("Missing capability: network:request");
		});

		it("blocks private network targets before dispatch", async () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

			try {
				const handler = makeHandler({ capabilities: ["network:fetch"], allowedHosts: ["*"] });
				const result = await call(handler, "http/fetch", {
					url: "http://127.0.0.1/internal",
				});
				expect(result.error).toContain("URLs targeting non-public IP addresses are not allowed");
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				fetchSpy.mockRestore();
			}
		});

		it.each(["http://[::]/internal", "http://100.100.100.200/internal"])(
			"blocks non-public network target %s before dispatch",
			async (url) => {
				const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

				try {
					const handler = makeHandler({ capabilities: ["network:fetch"], allowedHosts: ["*"] });
					const result = await call(handler, "http/fetch", { url });
					expect(result.error).toContain("URLs targeting non-public IP addresses are not allowed");
					expect(fetchSpy).not.toHaveBeenCalled();
				} finally {
					fetchSpy.mockRestore();
				}
			},
		);

		it("rejects email send without email:send capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "email/send", {
				message: { to: "a@b.com", subject: "hi", text: "hello" },
			});
			expect(result.error).toContain("Missing capability: email:send");
		});
	});

	// ── Storage (document store) ──────────────────────────────────────────

	describe("plugin storage", () => {
		it("applies guarded writes only within the trusted plugin and collection", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			const rows = [
				{ plugin_id: "test-plugin", collection: "records" },
				{ plugin_id: "test-plugin", collection: "other" },
				{ plugin_id: "other-plugin", collection: "records" },
			];
			for (const row of rows) {
				await db
					.insertInto("_plugin_storage")
					.values({
						...row,
						id: "constructor",
						data: '{"state":"ready"}',
						created_at: "2026-01-01",
						updated_at: "2026-01-01",
					})
					.execute();
			}
			expect(
				await call(handler, "storage/updateIf", {
					pluginId: "other-plugin",
					collection: "records",
					id: "constructor",
					args: { where: { state: "ready" }, set: { state: "running" } },
				}),
			).toEqual({ result: { applied: true, data: { state: "running" } } });
			for (const row of rows) {
				const current = await db
					.selectFrom("_plugin_storage")
					.select("data")
					.where("plugin_id", "=", row.plugin_id)
					.where("collection", "=", row.collection)
					.where("id", "=", "constructor")
					.executeTakeFirstOrThrow();
				expect(JSON.parse(current.data)).toEqual({
					state:
						row.plugin_id === "test-plugin" && row.collection === "records" ? "running" : "ready",
				});
			}
		});

		it("rejects guarded writes to undeclared collections", async () => {
			const handler = makeHandler({ storageCollections: ["records"] });
			const result = await call(handler, "storage/updateIf", {
				collection: "other",
				id: "item",
				args: { where: {}, set: { state: "running" } },
			});
			expect(result.error).toContain("Storage collection not declared: other");
		});

		it.each([
			null,
			{ where: [], set: { stock: 100 } },
			{ where: { stock: {} }, set: { stock: 100 } },
		])("rejects malformed guarded writes without changing the record: %s", async (args) => {
			const handler = makeHandler({ storageCollections: ["records"] });
			await call(handler, "storage/put", { collection: "records", id: "item", data: { stock: 2 } });
			expect(
				(await call(handler, "storage/updateIf", { collection: "records", id: "item", args }))
					.error,
			).toBeTypeOf("string");
			expect(
				(await call(handler, "storage/get", { collection: "records", id: "item" })).result,
			).toEqual({ stock: 2 });
		});

		it("rejects access to undeclared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "secrets",
				id: "1",
			});
			expect(result.error).toContain("Storage collection not declared: secrets");
		});

		it("allows access to declared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "1",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("put and get storage document", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			await call(handler, "storage/put", {
				collection: "logs",
				id: "log-1",
				data: { message: "hello", level: "info" },
			});
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "log-1",
			});
			expect(result.result).toEqual({ message: "hello", level: "info" });
		});

		it("storage is scoped per plugin", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});

			await call(handlerA, "storage/put", {
				collection: "data",
				id: "item-1",
				data: { owner: "a" },
			});

			// Plugin B cannot see plugin A's data
			const resultB = await call(handlerB, "storage/get", {
				collection: "data",
				id: "item-1",
			});
			expect(resultB.result).toBeNull();
		});
	});

	// ── Error Handling ────────────────────────────────────────────────────

	describe("error handling", () => {
		it("returns error for unknown bridge method", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "unknown/method");
			expect(result.error).toContain("Unknown bridge method: unknown/method");
		});

		it("returns error for missing required parameters", async () => {
			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/get", {});
			expect(result.error).toContain("Missing required string parameter");
		});
	});

	// ── Limit clamping ────────────────────────────────────────────────────

	describe("list endpoints clamp negative limit", () => {
		it("does not discard invalid content filters or ordering", async () => {
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();
			const handler = makeHandler({ capabilities: ["content:read"] });

			const result = await call(handler, "content/list", {
				collection: "posts",
				orderBy: { title: "sideways" },
			});

			expect(result.error).toContain(
				'Parameter orderBy must be an object mapping field to "asc"|"desc"',
			);
		});
		it("content/list clamps negative limit to 1", async () => {
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();
			for (const id of ["post-1", "post-2", "post-3"]) {
				await db
					.insertInto("ec_posts" as any)
					.values({ id, deleted_at: null, title: `Title ${id}` })
					.execute();
			}

			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/list", {
				collection: "posts",
				limit: -5,
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it.each([-5, 0])("media/list clamps a %s limit to 1", async (limit) => {
			await db.schema
				.createTable("media")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("filename", "text", (col) => col.notNull())
				.addColumn("mime_type", "text", (col) => col.notNull())
				.addColumn("size", "integer")
				.addColumn("storage_key", "text", (col) => col.notNull())
				.addColumn("status", "text", (col) => col.notNull().defaultTo("ready"))
				.addColumn("created_at", "text", (col) => col.notNull())
				.execute();
			for (const id of ["m-1", "m-2", "m-3"]) {
				await db
					.insertInto("media" as any)
					.values({
						id,
						filename: `${id}.png`,
						mime_type: "image/png",
						size: 100,
						storage_key: `keys/${id}`,
						status: "ready",
						created_at: new Date().toISOString(),
					})
					.execute();
			}

			const handler = makeHandler({ capabilities: ["read:media"] });
			const result = await call(handler, "media/list", { limit });
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it("media/list defaults a non-number limit", async () => {
			await db.schema
				.createTable("media")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("filename", "text", (col) => col.notNull())
				.addColumn("mime_type", "text", (col) => col.notNull())
				.addColumn("size", "integer")
				.addColumn("storage_key", "text", (col) => col.notNull())
				.addColumn("status", "text", (col) => col.notNull().defaultTo("ready"))
				.addColumn("created_at", "text", (col) => col.notNull())
				.execute();
			for (const id of ["m-1", "m-2", "m-3"]) {
				await db
					.insertInto("media" as any)
					.values({
						id,
						filename: `${id}.png`,
						mime_type: "image/png",
						size: 100,
						storage_key: `keys/${id}`,
						status: "ready",
						created_at: new Date().toISOString(),
					})
					.execute();
			}

			const handler = makeHandler({ capabilities: ["read:media"] });
			const result = await call(handler, "media/list", { limit: "bad" });
			expect(result.error).toBeUndefined();
			expect((result.result as { items: unknown[] }).items).toHaveLength(3);
		});

		it("storage/query clamps negative limit to 1", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			for (const id of ["log-1", "log-2", "log-3"]) {
				await call(handler, "storage/put", {
					collection: "logs",
					id,
					data: { message: id },
				});
			}

			const result = await call(handler, "storage/query", {
				collection: "logs",
				where: {},
				limit: -5,
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it("storage/query without limit returns all rows (undefined passthrough)", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			for (const id of ["log-1", "log-2", "log-3"]) {
				await call(handler, "storage/put", {
					collection: "logs",
					id,
					data: { message: id },
				});
			}

			const result = await call(handler, "storage/query", {
				collection: "logs",
				where: {},
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBe(3);
		});
	});

	// ── Logging ───────────────────────────────────────────────────────────

	describe("logging", () => {
		it("log call succeeds without capabilities", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "log", {
				level: "info",
				msg: "test message",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});
	});

	describe("HTTP response wire", () => {
		it("serializes one bounded binary response representation", async () => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
				new Response(INVALID_PLUGIN_HTTP_BYTES, {
					status: 206,
					statusText: "Partial Content",
					headers: { "content-type": "application/octet-stream" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				const handler = makeHandler({
					capabilities: ["network:request"],
					allowedHosts: ["93.184.216.34"],
				});
				const result = await call(handler, "http/fetch", {
					url: "https://93.184.216.34/file",
				});
				expect(result.error).toBeUndefined();
				expect(result.result).toMatchObject({
					status: 206,
					statusText: "Partial Content",
					headers: [["content-type", "application/octet-stream"]],
					finalUrl: "https://93.184.216.34/file",
					redirected: false,
					body: {
						__emdashBytes: Buffer.from(INVALID_PLUGIN_HTTP_BYTES).toString("base64"),
					},
				});
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("rejects an oversized decoded request before dispatch", async () => {
			const handler = makeHandler({
				capabilities: ["network:request"],
				allowedHosts: ["api.example.com"],
			});
			const result = await call(handler, "http/fetch", {
				url: "https://api.example.com/upload",
				init: {
					method: "POST",
					bodyType: "base64",
					body: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64"),
				},
			});
			expect(result.error).toMatch(/request body exceeds the 8388608 byte limit/i);
		});

		it.each([
			{
				caseName: "string body type",
				init: { bodyType: "string", body: "payload" },
				expectedError: 'init.bodyType must be "base64"',
			},
			{
				caseName: "form-data body type",
				init: { bodyType: "formdata", body: [] },
				expectedError: 'init.bodyType must be "base64"',
			},
			{
				caseName: "body without a body type",
				init: { body: "cGF5bG9hZA==" },
				expectedError: "init.bodyType and init.body must be present together",
			},
			{
				caseName: "body type without a body",
				init: { bodyType: "base64" },
				expectedError: "init.bodyType and init.body must be present together",
			},
		])("rejects $caseName before dispatch", async ({ init, expectedError }) => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const handler = makeHandler({
					capabilities: ["network:request"],
					allowedHosts: ["api.example.com"],
				});
				const result = await call(handler, "http/fetch", {
					url: "https://api.example.com/upload",
					init,
				});
				expect(result.error).toContain(expectedError);
				expect(fetchMock).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("rejects an oversized streamed response", async () => {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(bytesOverLimit(8 * 1024 * 1024)));
			vi.stubGlobal("fetch", fetchMock);
			try {
				const handler = makeHandler({
					capabilities: ["network:request"],
					allowedHosts: ["93.184.216.34"],
				});
				const result = await call(handler, "http/fetch", {
					url: "https://93.184.216.34/oversized",
				});
				expect(result.error).toMatch(/response body exceeds the 8388608 byte limit/i);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it.each([
			{ status: 301, method: "POST", rewritten: true },
			{ status: 302, method: "POST", rewritten: true },
			{ status: 303, method: "PUT", rewritten: true },
			{ status: 307, method: "POST", rewritten: false },
			{ status: 308, method: "POST", rewritten: false },
		])(
			"applies Fetch method and body rules for a $status redirect",
			async ({ status, method, rewritten }) => {
				const fetchMock = vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(
						new Response(null, {
							status,
							headers: { location: "https://93.184.216.34/final" },
						}),
					)
					.mockResolvedValueOnce(new Response("ok"));
				vi.stubGlobal("fetch", fetchMock);
				try {
					const handler = makeHandler({
						capabilities: ["network:request"],
						allowedHosts: ["93.184.216.34"],
					});
					const result = await call(handler, "http/fetch", {
						url: "https://93.184.216.34/start",
						init: {
							method,
							headers: [
								["content-type", "application/octet-stream"],
								["content-language", "en"],
								["content-length", String(INVALID_PLUGIN_HTTP_BYTES.byteLength)],
								["transfer-encoding", "chunked"],
							],
							bodyType: "base64",
							body: Buffer.from(INVALID_PLUGIN_HTTP_BYTES).toString("base64"),
						},
					});
					expect(result.error).toBeUndefined();
					const redirectedInit = fetchMock.mock.calls[1]?.[1];
					expect(redirectedInit?.method).toBe(rewritten ? "GET" : method);
					if (rewritten) expect(redirectedInit?.body).toBeUndefined();
					else expect(redirectedInit?.body).toBeInstanceOf(ArrayBuffer);
					const headers = new Headers(redirectedInit?.headers);
					expect(headers.get("content-type")).toBe(rewritten ? null : "application/octet-stream");
					expect(headers.get("content-language")).toBe(rewritten ? null : "en");
					expect(headers.get("content-length")).toBe(
						rewritten ? null : String(INVALID_PLUGIN_HTTP_BYTES.byteLength),
					);
					expect(headers.get("transfer-encoding")).toBe(rewritten ? null : "chunked");
				} finally {
					vi.unstubAllGlobals();
				}
			},
		);

		it.each([
			{ mode: "manual", expectedError: false },
			{ mode: "error", expectedError: true },
		] as const)("honors redirect mode $mode", async ({ mode, expectedError }) => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://93.184.216.34/final" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				const handler = makeHandler({
					capabilities: ["network:request"],
					allowedHosts: ["93.184.216.34"],
				});
				const result = await call(handler, "http/fetch", {
					url: "https://93.184.216.34/start",
					init: { redirect: mode },
				});
				if (expectedError) expect(result.error).toMatch(/redirect mode is "error"/i);
				else expect(result.result).toMatchObject({ status: 302, redirected: false });
				expect(fetchMock).toHaveBeenCalledOnce();
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("does not follow a non-redirect 3xx response with Location", async () => {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
				new Response(null, {
					status: 304,
					headers: { location: "https://93.184.216.34/final" },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);
			try {
				const handler = makeHandler({
					capabilities: ["network:request"],
					allowedHosts: ["93.184.216.34"],
				});
				const result = await call(handler, "http/fetch", {
					url: "https://93.184.216.34/start",
				});
				expect(result.result).toMatchObject({ status: 304, redirected: false });
				expect(fetchMock).toHaveBeenCalledOnce();
			} finally {
				vi.unstubAllGlobals();
			}
		});
	});

	// ── Batch transactionality ────────────────────────────────────────────

	it("checks the activation fence at the sandbox content-write boundary", async () => {
		const beforeContentWrite = vi.fn(async () => {
			throw Object.assign(new Error("Media usage activation is in progress"), {
				name: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				status: 503,
			});
		});
		const handler = makeHandler({
			capabilities: ["write:content"],
			beforeContentWrite,
		});

		const response = await handler(
			new Request("http://bridge/content/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					collection: "posts",
					data: { slug: "blocked" },
				}),
			}),
		);

		expect(response.status).toBe(503);
		expect((await response.json()) as unknown).toEqual({
			error: {
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
				status: 503,
			},
		});
		expect(beforeContentWrite).toHaveBeenCalledOnce();
	});

	describe("batch operations are transactional", () => {
		beforeEach(async () => {
			await db.schema
				.createTable("ec_atomic_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("slug", "text", (col) => col.unique())
				.addColumn("status", "text", (col) => col.defaultTo("draft"))
				.addColumn("title", "text")
				.addColumn("created_at", "text")
				.addColumn("updated_at", "text")
				.addColumn("deleted_at", "text")
				.addColumn("version", "integer", (col) => col.defaultTo(1))
				.addColumn("author_id", "text")
				.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
				.addColumn("translation_group", "text")
				.execute();
		});

		it("contentCreateMany rolls back when a mid-batch insert fails", async () => {
			const handler = makeHandler({ capabilities: ["write:content"] });
			// Pre-insert a row that will collide with item index 2's slug.
			await call(handler, "content/create", {
				collection: "atomic_posts",
				data: { slug: "conflict", title: "existing" },
			});

			const before = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(before).toHaveLength(1);

			const result = await call(handler, "content/createMany", {
				collection: "atomic_posts",
				items: [
					{ slug: "a", title: "ok 1" },
					{ slug: "b", title: "ok 2" },
					{ slug: "conflict", title: "should fail" },
					{ slug: "d", title: "would be ok" },
				],
			});
			expect(result.error).toBeDefined();

			// After the failed batch, only the pre-existing row should remain.
			const after = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(after).toHaveLength(1);
			expect((after[0] as any).slug).toBe("conflict");
		});

		it("contentCreateMany commits all when no item fails", async () => {
			const handler = makeHandler({ capabilities: ["write:content"] });
			const result = await call(handler, "content/createMany", {
				collection: "atomic_posts",
				items: [
					{ slug: "x1", title: "1" },
					{ slug: "x2", title: "2" },
					{ slug: "x3", title: "3" },
				],
			});
			expect(result.result).toBeDefined();
			const rows = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(rows).toHaveLength(3);
		});
	});
});
