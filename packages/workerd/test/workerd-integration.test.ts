/**
 * Workerd Integration Tests
 *
 * These tests spawn a real workerd process and exercise the full plugin
 * lifecycle: load, invoke hooks/routes, unload, and error handling.
 *
 * Skipped if the workerd binary is not available (e.g., in CI without
 * the workerd package installed).
 */

import Database from "better-sqlite3";
import {
	ContentRepository,
	createSandboxRouteError,
	RevisionRepository,
	SchemaRegistry,
} from "emdash";
import type { RuntimeDependencies } from "emdash/plugin-test-runtime";
import { Kysely, SqliteDialect, type QueryId } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

vi.mock("virtual:emdash/config", () => ({ default: null }), { virtual: true });
vi.mock("virtual:emdash/object-cache", () => ({ default: null }), { virtual: true });

// Check at module level so describe.skipIf works
let workerdAvailable = false;
try {
	const testRunner = new WorkerdSandboxRunner({ db: null as any });
	workerdAvailable = testRunner.isAvailable();
} catch {
	// workerd not available
}

function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function setupTables(db: Kysely<any>) {
	await db.schema
		.createTable("options")
		.addColumn("name", "text", (col) => col.primaryKey())
		.addColumn("value", "text", (col) => col.notNull())
		.addColumn("revision", "text", (col) => col.notNull())
		.execute();

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
		.createTable("ec_posts")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("slug", "text")
		.addColumn("status", "text", (col) => col.defaultTo("draft"))
		.addColumn("title", "text")
		.addColumn("author_id", "text")
		.addColumn("created_at", "text")
		.addColumn("updated_at", "text")
		.addColumn("published_at", "text")
		.addColumn("scheduled_at", "text")
		.addColumn("deleted_at", "text")
		.addColumn("version", "integer", (col) => col.defaultTo(1))
		.addColumn("live_revision_id", "text")
		.addColumn("draft_revision_id", "text")
		.execute();

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

	await db.schema
		.createTable("media")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("filename", "text", (col) => col.notNull())
		.addColumn("mime_type", "text", (col) => col.notNull())
		.addColumn("size", "integer")
		.addColumn("width", "integer")
		.addColumn("height", "integer")
		.addColumn("focal_x", "real")
		.addColumn("focal_y", "real")
		.addColumn("alt", "text")
		.addColumn("caption", "text")
		.addColumn("storage_key", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull())
		.addColumn("content_hash", "text")
		.addColumn("blurhash", "text")
		.addColumn("dominant_color", "text")
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("author_id", "text")
		.addColumn("folder_id", "text")
		.execute();
}

/** Minimal plugin code that echoes back hook/route calls.
 * Route handlers receive { input, request, requestMeta } as first arg. */
const ECHO_PLUGIN = `
export default {
	hooks: {
		"content:beforeSave": {
			handler: async (event, ctx) => {
				await ctx.kv.set("last-hook", JSON.stringify({ hook: "content:beforeSave", event }));
				return event;
			}
		}
	},
	routes: {
		"echo": {
			handler: async (routeCtx, ctx) => {
				const kvValue = await ctx.kv.get("last-hook");
				return { input: routeCtx.input, kvValue, ui: routeCtx.ui };
			}
		},
		"editor-draft": {
			handler: async (routeCtx) => ({
				snapshot: routeCtx.input.draft,
				patch: {
					type: "editor-draft-patch",
					operations: [{ op: "set", field: "title", value: routeCtx.input.draft.fields.title + " translated" }]
				}
			})
		},
		"kv-test": {
			handler: async (routeCtx, ctx) => {
				await ctx.kv.set("test-key", routeCtx.input.value);
				const result = await ctx.kv.get("test-key");
				return { stored: result };
			}
		},
		"cron-test": {
			handler: async (_routeCtx, ctx) => {
				await ctx.cron.schedule("daily", { schedule: "@daily", data: { source: "workerd" } });
				return ctx.cron.list();
			}
		},
		"conditional-test": {
			handler: async (_routeCtx, ctx) => {
				const results = [];
				for (const store of [ctx.kv, ctx.storage.records]) {
					const created = await store.compareAndSet("__proto__", null, null);
					const saved = await store.getVersioned("__proto__");
					const conflict = await store.compareAndSet("__proto__", null, "overwrite");
					const updated = await store.compareAndSet("__proto__", saved.revision, { status: "ready" });
					const staleDelete = await store.compareAndDelete("__proto__", saved.revision);
					const deleted = await store.compareAndDelete("__proto__", updated.revision);
					results.push({ created, saved, conflict, updated, staleDelete, deleted, missing: await store.getVersioned("__proto__") });
				}
				return results;
			}
		}
	}
};
`;

const UPDATE_IF_PLUGIN = `
export default {
	routes: {
		reserve: {
			handler: async (_routeCtx, ctx) => {
				const store = ctx.storage.records;
				await store.put("stock", { stock: 2, title: "retained" });
				const outcomes = await Promise.all(Array.from({ length: 4 }, () =>
					store.updateIf("stock", { where: { stock: { gte: 1 } }, delta: { stock: { dec: 1 } } })
				));
				return { outcomes, saved: await store.get("stock") };
			}
		},
		retry: {
			handler: async (_routeCtx, ctx) => {
				try {
					await ctx.storage.records.updateIf("stock", { where: {}, set: { stock: 1 } });
					return { unexpectedSuccess: true };
				} catch (error) {
					return {
						name: error.name, code: error.code, retryable: error.retryable,
						sqlState: error.sqlState, message: error.message, hasCause: "cause" in error
					};
				}
			}
		}
	}
};
`;

/** Plugin that sleeps longer than the wall-time limit */
const SLOW_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"slow": {
			handler: async () => {
				await new Promise(r => setTimeout(r, 60000));
				return { done: true };
			}
		}
	}
};
`;

const CONTENT_ACTION_HANG_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"publish-hang": {
			handler: async (_route, ctx) => {
				await ctx.content.publish("posts", "post-1", { _rev: "revision-1" });
				await new Promise((resolve) => setTimeout(resolve, 60000));
			}
		}
	}
};
`;

const CONTENT_WRITE_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"write": {
			handler: async (_routeCtx, ctx) => ctx.content.create("posts", { slug: "blocked" })
		}
	}
};
`;

const SETTINGS_PLUGIN = `
export default {
	routes: {
		"save": {
			handler: async (route, ctx) => {
				await ctx.settings.set("apiKey", route.input.value);
				return {
					settings: await ctx.settings.get("apiKey"),
					alias: await ctx.kv.get("settings:apiKey")
				};
			}
		}
	}
};
`;

const BINARY_HTTP_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"roundtrip": {
			handler: async (route, ctx) => {
				const response = await ctx.http.fetch(route.input.url, {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: new Uint8Array([0, 255, 195, 40])
				});
				const clone = response.clone();
				return {
					status: response.status,
					statusText: response.statusText,
					url: response.url,
					redirected: response.redirected,
					bytes: [...new Uint8Array(await response.arrayBuffer())],
					cloneBytes: [...new Uint8Array(await clone.arrayBuffer())]
				};
			}
		}
	}
};
`;

const RAW_ROUTE_PLUGIN = `
export default {
	routes: {
		bytes: {
			handler: async ({ input }) => ({
				__emdashPluginResponse: true,
				status: 206,
				headers: [["content-type", "application/octet-stream"]],
				body: { kind: "bytes", value: input }
			})
		},
		multipart: {
			handler: async ({ input }) => ({
				__emdashPluginResponse: true,
				status: 200,
				headers: [],
				body: { kind: "bytes", value: input.entries[1].bytes }
			})
		},
		ordinary: {
			handler: async () => ({
				status: 201,
				headers: [["x-test", "ordinary"]],
				body: { kind: "text", value: "not raw" }
			})
		}
	}
};
`;

const SAVE_REJECTION_PLUGIN = `
export default {
	hooks: {
		"content:beforeSave": async () => ({
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a summary" }
		})
	}
};
`;

const CONTENT_POLICY_PLUGIN = `
export default {
	hooks: {
		"content:beforePublish": async (event, ctx) => ({
			cancel: true,
			reason: ctx.content === undefined
				? event.origin.source + ": " + event.content.title
				: "content access leaked"
		})
	}
};
`;

const RUNTIME_HOST_PLUGIN = `
let isolateId;
export default {
	hooks: {
		"content:beforeSave": async (event, ctx) => {
			await ctx.kv.set("saw-save", true);
			if (event.content.rejectSave === true) {
				return {
					__emdashSandboxHookResult: true,
					version: 1,
					error: { code: "SAVE_REJECTED", reason: "Translation needs review" }
				};
			}
			if (event.content.createCompanion === true) {
				await ctx.content.create("posts", { title: "Companion" });
			}
			const content = { ...event.content };
			delete content.createCompanion;
			return { ...content, title: event.content.title + " [workerd]" };
		}
	},
	routes: {
		"state": {
			handler: async (_route, ctx) => ({ isolateId: isolateId ??= crypto.randomUUID(), sawSave: await ctx.kv.get("saw-save") })
		},
		"translate": {
			handler: async (route, ctx) => ctx.content.create(
				"posts",
				{ title: route.input.title },
				{
					locale: route.input.locale,
					translationOf: route.input.translationOf,
					__emdashOriginHook: "content:beforeSave"
				}
			)
		},
		"translate-error": {
			handler: async (route, ctx) => {
				try {
					await ctx.content.create(
						"posts",
						{ title: "Attempt", rejectSave: route.input.rejectSave },
						{ locale: route.input.locale, translationOf: route.input.translationOf }
					);
					return { unexpectedSuccess: true };
				} catch (error) {
					return { name: error.name, code: error.code, message: error.message };
				}
			}
		},
		"publish": {
			handler: async (route, ctx) => {
				const current = await ctx.content.getVersioned("posts", route.input.id);
				return ctx.content.publish("posts", route.input.id, { _rev: current._rev });
			}
		}
	}
};
`;

const CONTENT_DISCOVERY_PLUGIN = `
export default {
	hooks: {},
	routes: {
		"discover": {
			handler: async (route, ctx) => ({
				schema: await ctx.schema.getCollection("posts"),
				item: await ctx.content.get("posts", route.input.id),
				translations: await ctx.content.getTranslations("posts", route.input.id),
				publicUrl: await ctx.content.getPublicUrl("posts", route.input.id),
				revisions: await ctx.content.listRevisions("posts", route.input.id)
			})
		},
		"revisions": {
			handler: async (route, ctx) => ({
				list: await ctx.content.listRevisions("posts", route.input.id),
				item: await ctx.content.getRevision("posts", route.input.id, route.input.revisionId)
			})
		}
	}
};
`;

const TAXONOMY_WRITE_PLUGIN = `
export default {
	routes: {
		create: {
			handler: async (route, ctx) => ctx.taxonomies.createTerm("category", route.input)
		},
		add: {
			handler: async (route, ctx) => ctx.taxonomies.addEntryTerms("posts", route.input.entryId, "category", route.input.termIds)
		},
		remove: {
			handler: async (route, ctx) => ctx.taxonomies.removeEntryTerms("posts", route.input.entryId, "category", route.input.termIds)
		}
	}
};
`;

const MEDIA_PLUGIN = `
export default {
	routes: {
		"get": {
			handler: async (route, ctx) => ctx.media.get(route.input.id)
		},
		"read": {
			handler: async (route, ctx) => {
				const result = await ctx.media.readBytes(route.input.id, { maxBytes: route.input.maxBytes });
				return { ...result, bytes: Array.from(result.bytes) };
			}
		},
		"update": {
			handler: async (route, ctx) => ctx.media.updateMetadata(route.input.id, route.input.patch)
		}
	}
};
`;

describe.skipIf(!workerdAvailable)("WorkerdSandboxRunner integration", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;
	let runner: WorkerdSandboxRunner;

	beforeEach(async () => {
		const testDb = createTestDb();
		db = testDb.db;
		sqlite = testDb.sqlite;
		await setupTables(db);

		runner = new WorkerdSandboxRunner({ db });
	});

	afterEach(async () => {
		await runner.terminateAll();
		await db.destroy();
		sqlite.close();
	});

	it("loads a plugin and invokes a route", async () => {
		const plugin = await runner.load(
			{
				id: "test-echo",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = (await plugin.invokeRoute(
			"echo",
			{ hello: "world" },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
				ui: { surface: "dashboard-widget", locale: "ar", direction: "rtl" },
			},
		)) as any;

		expect(result).toBeDefined();
		expect(result.input).toEqual({ hello: "world" });
		expect(result.ui).toEqual({ surface: "dashboard-widget", locale: "ar", direction: "rtl" });
	}, 30_000);

	it("preserves editor draft snapshots and patch effects through the route transport", async () => {
		const plugin = await runner.load(
			{
				id: "test-editor-draft",
				version: "1.0.0",
				capabilities: ["admin.editor-draft:read", "admin.editor-draft:patch"],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);
		const draft = {
			collection: "posts",
			entryId: "entry-1",
			locale: "en",
			baseRevision: "rev-1",
			invocationId: "workerd_invocation",
			fields: { title: "Unsaved" },
			fieldDefinitions: [
				{ slug: "title", label: "Title", type: "string", required: true, translatable: true },
			],
		};
		await expect(
			plugin.invokeRoute(
				"editor-draft",
				{ type: "editor_action", draft },
				{ method: "POST", url: "/api/editor-draft", headers: {} },
			),
		).resolves.toEqual({
			snapshot: draft,
			patch: {
				type: "editor-draft-patch",
				operations: [{ op: "set", field: "title", value: "Unsaved translated" }],
			},
		});
	}, 30_000);

	it("preserves bounded media bytes and metadata through a real workerd process", async () => {
		const stored = new Map([["private/original.bin", new Uint8Array([0, 255, 17, 42])]]);
		runner = new WorkerdSandboxRunner({
			db,
			mediaStorage: {
				async upload({ key, body }) {
					stored.set(key, new Uint8Array(body));
				},
				async download(key) {
					const bytes = stored.get(key);
					if (!bytes) throw new Error("Missing test object");
					return {
						body: new Blob([bytes.slice().buffer]).stream(),
						contentType: "application/octet-stream",
						size: 1,
					};
				},
				async delete(key) {
					stored.delete(key);
				},
			},
		});
		await db
			.insertInto("media" as any)
			.values({
				id: "media-1",
				filename: "original.bin",
				mime_type: "application/octet-stream",
				size: 1,
				storage_key: "private/original.bin",
				status: "ready",
				content_hash: "sha1:original",
				created_at: "2030-01-02T03:04:05.000Z",
				author_id: "private-author",
			})
			.execute();
		const plugin = await runner.load(
			{
				id: "test-media",
				version: "1.0.0",
				capabilities: ["media:read", "media:bytes:read", "media:metadata:write"],
				allowedHosts: [],
				storage: {},
			},
			MEDIA_PLUGIN,
		);

		await expect(
			plugin.invokeRoute(
				"read",
				{ id: "media-1", maxBytes: 3 },
				{ method: "POST", url: "/api/media/read", headers: {} },
			),
		).rejects.toThrow("Media exceeds the requested 3-byte limit");
		await expect(
			plugin.invokeRoute(
				"read",
				{ id: "media-1", maxBytes: 4 },
				{ method: "POST", url: "/api/media/read", headers: {} },
			),
		).resolves.toEqual({
			bytes: [0, 255, 17, 42],
			filename: "original.bin",
			mimeType: "application/octet-stream",
			size: 4,
			contentHash: "sha1:original",
		});

		const metadata = await plugin.invokeRoute(
			"get",
			{ id: "media-1" },
			{ method: "POST", url: "/api/media/get", headers: {} },
		);
		expect(metadata).not.toHaveProperty("storageKey");
		expect(metadata).not.toHaveProperty("authorId");
		expect(metadata).not.toHaveProperty("contentHash");
		await expect(
			plugin.invokeRoute(
				"update",
				{ id: "media-1", patch: { alt: "Binary fixture" } },
				{ method: "POST", url: "/api/media/update", headers: {} },
			),
		).resolves.toMatchObject({ id: "media-1", alt: "Binary fixture" });
		await expect(
			db
				.selectFrom("media" as any)
				.selectAll()
				.where("id" as any, "=", "media-1")
				.executeTakeFirst(),
		).resolves.toMatchObject({
			alt: "Binary fixture",
			storage_key: "private/original.bin",
			content_hash: "sha1:original",
		});
	}, 30_000);

	it("preserves concurrent binary HTTP through the real workerd bridge", async () => {
		await runner.terminateAll();
		const requests: Array<{ url: string; body: Uint8Array }> = [];
		runner = new WorkerdSandboxRunner({
			db,
			httpFetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push({
					url: request.url,
					body: new Uint8Array(await request.arrayBuffer()),
				});
				const second = request.url.endsWith("/second");
				return new Response(
					second ? new Uint8Array([137, 80, 78, 71]) : new Uint8Array([0, 255, 195, 40]),
					{
						status: second ? 200 : 206,
						statusText: second ? "OK" : "Partial Content",
						headers: { "content-type": "application/octet-stream" },
					},
				);
			},
		});
		const plugin = await runner.load(
			{
				id: "binary-http",
				version: "1.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["93.184.216.34"],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		const urls = ["https://93.184.216.34/first", "https://93.184.216.34/second"];
		const results = await Promise.all(
			urls.map((url) =>
				plugin.invokeRoute(
					"roundtrip",
					{ url },
					{ method: "POST", url: "/api/roundtrip", headers: {} },
				),
			),
		);

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					status: 206,
					statusText: "Partial Content",
					url: urls[0],
					bytes: [0, 255, 195, 40],
					cloneBytes: [0, 255, 195, 40],
				}),
				expect.objectContaining({
					status: 200,
					url: urls[1],
					bytes: [137, 80, 78, 71],
					cloneBytes: [137, 80, 78, 71],
				}),
			]),
		);
		expect(requests).toEqual(
			expect.arrayContaining(urls.map((url) => ({ url, body: new Uint8Array([0, 255, 195, 40]) }))),
		);
	}, 30_000);

	it("preserves raw route and multipart bytes through the real workerd wrapper", async () => {
		const bytes = new Uint8Array([0, 255, 195, 40]);
		const plugin = await runner.load(
			{
				id: "raw-route-transport",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			RAW_ROUTE_PLUGIN,
		);
		const request = { method: "POST", url: "/api/raw", headers: {} };

		const concurrentBodies = [bytes, new Uint8Array([1, 2, 3]), new Uint8Array([254, 253])];
		const concurrentResults = await Promise.all(
			concurrentBodies.map((body) => plugin.invokeRoute("bytes", body, request)),
		);
		expect(concurrentResults).toEqual(
			concurrentBodies.map((body) => ({
				__emdashPluginResponse: true,
				status: 206,
				headers: [["content-type", "application/octet-stream"]],
				body: { kind: "bytes", value: body },
			})),
		);

		const multipart = {
			entries: [
				{ name: "caption", kind: "text", value: "binary" },
				{
					name: "upload",
					kind: "file",
					filename: "invalid.bin",
					contentType: "application/octet-stream",
					bytes,
				},
			],
		};
		await expect(plugin.invokeRoute("multipart", multipart, request)).resolves.toMatchObject({
			__emdashPluginResponse: true,
			body: { kind: "bytes", value: bytes },
		});

		await expect(plugin.invokeRoute("ordinary", {}, request)).resolves.toEqual({
			status: 201,
			headers: [["x-test", "ordinary"]],
			body: { kind: "text", value: "not raw" },
		});
	}, 30_000);

	it("drops cached network authority when a plugin version is replaced", async () => {
		await runner.terminateAll();
		const httpFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(new Uint8Array([0, 255]), {
				status: 206,
				statusText: "Partial Content",
				headers: { "content-type": "application/octet-stream" },
			}),
		);
		runner = new WorkerdSandboxRunner({ db, httpFetch });
		const unrestricted = await runner.load(
			{
				id: "authority-update",
				version: "1.0.0",
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		await expect(
			unrestricted.invokeRoute(
				"roundtrip",
				{ url: "https://93.184.216.34/first" },
				{ method: "POST", url: "/api/roundtrip", headers: {} },
			),
		).resolves.toMatchObject({ status: 206 });
		await unrestricted.terminate();

		const restricted = await runner.load(
			{
				id: "authority-update",
				version: "2.0.0",
				capabilities: ["network:request"],
				allowedHosts: ["api.example.com"],
				storage: {},
			},
			BINARY_HTTP_PLUGIN,
		);
		await expect(
			restricted.invokeRoute(
				"roundtrip",
				{ url: "https://93.184.216.34/second" },
				{ method: "POST", url: "/api/roundtrip", headers: {} },
			),
		).rejects.toThrow(/not allowed to fetch from host/i);
		expect(httpFetch).toHaveBeenCalledOnce();
	}, 30_000);

	it("runs an equivalent runtime content and cold-restart journey through workerd", async () => {
		const { EmDashRuntime } = await import("emdash/plugin-test-runtime");
		const runtimeSqlite = new Database(":memory:");
		const deps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `workerd-runtime-${crypto.randomUUID()}`,
					type: "sqlite",
					config: {},
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: runtimeSqlite }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [
				{
					id: "runtime-workerd",
					version: "1.0.0",
					options: {},
					code: RUNTIME_HOST_PLUGIN,
					capabilities: ["content:write", "content:publish"],
					allowedHosts: [],
					storage: {},
					hooks: ["content:beforeSave"],
					routes: [
						{ name: "state", public: true },
						{ name: "translate", public: true },
						{ name: "translate-error", public: true },
						{ name: "publish", public: true },
					],
				},
			],
			createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
		};
		let runtime = await EmDashRuntime.create(deps);
		try {
			await new SchemaRegistry(runtime.db).createCollection({ slug: "posts", label: "Posts" });
			await new SchemaRegistry(runtime.db).createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			const created = await runtime.handleContentCreate("posts", { data: { title: "Original" } });
			expect(created).toMatchObject({
				success: true,
				data: { item: { data: { title: "Original [workerd]" } } },
			});
			if (!created.success) return;
			const translated = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"POST",
				"/translate",
				new Request("https://test.local/translate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: "Bonjour",
						locale: "fr",
						translationOf: created.data.item.id,
					}),
				}),
			);
			expect(translated).toMatchObject({
				success: true,
				data: {
					locale: "fr",
					translationGroup: created.data.item.translationGroup,
					data: { title: "Bonjour [workerd]" },
				},
			});
			const nested = await runtime.handleContentCreate("posts", {
				data: { title: "Nested", createCompanion: true },
			});
			expect(nested).toMatchObject({
				success: true,
				data: { item: { data: { title: "Nested [workerd]" } } },
			});
			const items = await new ContentRepository(runtime.db).findMany("posts", { limit: 10 });
			expect(items.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ data: { title: "Nested [workerd]" } }),
					expect.objectContaining({ data: { title: "Companion" } }),
				]),
			);
			for (const [input, code] of [
				[{ title: "Duplicate", locale: "fr", translationOf: created.data.item.id }, "CONFLICT"],
				[{ title: "Missing", locale: "fr", translationOf: "missing" }, "NOT_FOUND"],
				[
					{ title: "Invalid", locale: "not_configured", translationOf: created.data.item.id },
					"VALIDATION_ERROR",
				],
				[{ title: "Rejected", locale: "de", rejectSave: true }, "SAVE_REJECTED"],
			] as const) {
				const failed = await runtime.handlePluginApiRoute(
					"runtime-workerd",
					"POST",
					"/translate-error",
					new Request("https://test.local/translate-error", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(input),
					}),
				);
				expect(failed).toMatchObject({ success: true, data: { name: code, code } });
			}
			const published = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"POST",
				"/publish",
				new Request("https://test.local/publish", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: created.data.item.id }),
				}),
			);
			expect(published).toMatchObject({
				success: true,
				data: { item: { id: created.data.item.id, status: "published" } },
			});
			const first = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"GET",
				"/state",
				new Request("https://test.local/state"),
			);
			await runtime.shutdown();
			runtime = await EmDashRuntime.create(deps);
			const second = await runtime.handlePluginApiRoute(
				"runtime-workerd",
				"GET",
				"/state",
				new Request("https://test.local/state"),
			);
			expect(second).toMatchObject({ success: true, data: { sawSave: true } });
			expect(second.success && first.success && second.data.isolateId).not.toBe(
				first.success ? first.data.isolateId : undefined,
			);
		} finally {
			await runtime.shutdown();
			await runtime.db.destroy();
			runtimeSqlite.close();
		}
	}, 30_000);

	it("discovers schema, content identity, public URLs, and revisions through real workerd", async () => {
		const { EmDashRuntime } = await import("emdash/plugin-test-runtime");
		const runtimeSqlite = new Database(":memory:");
		const deps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `workerd-discovery-${crypto.randomUUID()}`,
					type: "sqlite",
					config: {},
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: runtimeSqlite }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [
				{
					id: "workerd-discovery",
					version: "1.0.0",
					options: {},
					code: CONTENT_DISCOVERY_PLUGIN,
					capabilities: ["schema:read", "content:read", "content:revisions:read"],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [
						{ name: "discover", public: true },
						{ name: "revisions", public: true },
					],
				},
			],
			createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
			siteInfo: {
				url: "https://example.test",
				locale: "en",
				trailingSlash: "always",
			},
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			await new SchemaRegistry(runtime.db).createCollection({
				slug: "posts",
				label: "Posts",
				urlPattern: "/journal/{slug}",
			});
			await new SchemaRegistry(runtime.db).createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			const post = await new ContentRepository(runtime.db).create({
				type: "posts",
				slug: "hello",
				status: "published",
				locale: "en",
				authorId: "author-1",
				data: { title: "Hello" },
			});
			const revision = await new RevisionRepository(runtime.db).create({
				collection: "posts",
				entryId: post.id,
				data: { title: "Retained" },
			});
			const result = await runtime.handlePluginApiRoute(
				"workerd-discovery",
				"POST",
				"/discover",
				new Request("https://example.test/discover", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: post.id }),
				}),
			);

			expect(result).toMatchObject({
				success: true,
				data: {
					schema: { slug: "posts", fields: [{ slug: "title" }] },
					item: { id: post.id, authorId: "author-1", version: 1 },
					publicUrl: "https://example.test/journal/hello/",
					revisions: [{ data: { title: "Retained" } }],
				},
			});
			await new ContentRepository(runtime.db).delete("posts", post.id);
			const hidden = await runtime.handlePluginApiRoute(
				"workerd-discovery",
				"POST",
				"/revisions",
				new Request("https://example.test/revisions", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: post.id, revisionId: revision.id }),
				}),
			);
			expect(hidden).toEqual({ success: true, data: { list: [], item: null } });
		} finally {
			await runtime.shutdown();
			await runtime.db.destroy();
			runtimeSqlite.close();
		}
	}, 30_000);

	it("runs runtime-owned taxonomy mutations through a real workerd isolate", async () => {
		const { EmDashRuntime, TaxonomyRepository } = await import("emdash/plugin-test-runtime");
		const runtimeSqlite = new Database(":memory:");
		const deps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `workerd-taxonomies-${crypto.randomUUID()}`,
					type: "sqlite",
					config: {},
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: runtimeSqlite }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [
				{
					id: "taxonomy-writer",
					version: "1.0.0",
					options: {},
					code: TAXONOMY_WRITE_PLUGIN,
					capabilities: ["taxonomies:read", "taxonomies:write"],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [{ name: "create" }, { name: "add" }, { name: "remove" }],
				},
				{
					id: "taxonomy-reader",
					version: "1.0.0",
					options: {},
					code: TAXONOMY_WRITE_PLUGIN,
					capabilities: ["taxonomies:read"],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [{ name: "add" }],
				},
			],
			createSandboxRunner: (options) => new WorkerdSandboxRunner(options),
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			await new SchemaRegistry(runtime.db).createCollection({ slug: "posts", label: "Posts" });
			const content = await runtime.handleContentCreate("posts", { data: {} });
			if (!content.success) throw new Error(content.error.message);
			await runtime.db
				.updateTable("_emdash_taxonomy_defs")
				.set({ collections: '["posts"]' })
				.where("name", "in", ["category", "tag"])
				.execute();
			const taxonomyRepo = new TaxonomyRepository(runtime.db);
			const news = await taxonomyRepo.create({
				name: "category",
				slug: "news",
				label: "News",
				locale: "en",
			});
			const unrelated = await taxonomyRepo.create({
				name: "tag",
				slug: "ai",
				label: "AI",
				locale: "en",
			});
			const writer = runtime.sandboxedPlugins.get("taxonomy-writer:1.0.0");
			const reader = runtime.sandboxedPlugins.get("taxonomy-reader:1.0.0");
			if (!writer || !reader) throw new Error("Taxonomy workerd isolates were not loaded");
			const request = { method: "POST", url: "/taxonomy", headers: {} };
			const created = (await writer.invokeRoute("create", { label: "Reviews" }, request)) as {
				id: string;
			};
			await Promise.all([
				writer.invokeRoute("add", { entryId: content.data.item.id, termIds: [news.id] }, request),
				writer.invokeRoute(
					"add",
					{ entryId: content.data.item.id, termIds: [created.id] },
					request,
				),
			]);
			expect(
				(await taxonomyRepo.getTermsForEntry("posts", content.data.item.id, "category", "en"))
					.map((term) => term.slug)
					.toSorted(),
			).toEqual(["news", "reviews"]);
			await expect(
				writer.invokeRoute(
					"add",
					{ entryId: content.data.item.id, termIds: [unrelated.id] },
					request,
				),
			).rejects.toThrow("belongs to 'tag'");
			await expect(
				reader.invokeRoute("add", { entryId: content.data.item.id, termIds: [news.id] }, request),
			).rejects.toThrow("Missing capability: taxonomies:write");
			await writer.invokeRoute(
				"remove",
				{ entryId: content.data.item.id, termIds: [news.id] },
				request,
			);
			expect(
				(await taxonomyRepo.getTermsForEntry("posts", content.data.item.id, "category", "en")).map(
					(term) => term.slug,
				),
			).toEqual(["reviews"]);
		} finally {
			await runtime.shutdown();
			await runtime.db.destroy();
			runtimeSqlite.close();
		}
	}, 30_000);

	it("loads a plugin and invokes a hook", async () => {
		const plugin = await runner.load(
			{
				id: "test-echo",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = await plugin.invokeHook("content:beforeSave", {
			content: { title: "Test" },
		});

		expect(result).toBeDefined();

		// Verify KV was written via the hook
		const kvResult = (await plugin.invokeRoute(
			"echo",
			{},
			{
				method: "GET",
				url: "/api/test",
				headers: {},
			},
		)) as any;

		expect(kvResult.kvValue).toBeTruthy();
		const parsed = JSON.parse(kvResult.kvValue);
		expect(parsed.hook).toBe("content:beforeSave");
	}, 30_000);

	it("preserves a versioned hook error result over the workerd HTTP transport", async () => {
		const plugin = await runner.load(
			{
				id: "test-save-rejection",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			SAVE_REJECTION_PLUGIN,
		);

		await expect(plugin.invokeHook("content:beforeSave", {})).resolves.toEqual({
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a summary" },
		});
	}, 30_000);

	it("preserves publication policy events and decisions over the workerd transport", async () => {
		const plugin = await runner.load(
			{
				id: "test-content-policy",
				version: "1.0.0",
				capabilities: ["hooks.content-policy:register"],
				allowedHosts: [],
				storage: {},
			},
			CONTENT_POLICY_PLUGIN,
		);

		await expect(
			plugin.invokeHook("content:beforePublish", {
				collection: "posts",
				content: { id: "post-1", title: "Needs approval" },
				origin: { source: "plugin", pluginId: "review-cycle" },
			}),
		).resolves.toEqual({ cancel: true, reason: "plugin: Needs approval" });
	}, 30_000);

	it("enforces KV isolation between plugins via routes", async () => {
		const plugin = await runner.load(
			{
				id: "test-kv",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const result = (await plugin.invokeRoute(
			"kv-test",
			{ value: "hello" },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;

		expect(result.stored).toBe("hello");
	}, 30_000);

	it("encrypts settings through the production workerd process", async () => {
		vi.stubEnv(
			"EMDASH_ENCRYPTION_KEY",
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		const plugin = await runner.load(
			{
				id: "test-settings",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				admin: { settingsSchema: { apiKey: { type: "secret", label: "API key" } } },
			},
			SETTINGS_PLUGIN,
		);

		await expect(
			plugin.invokeRoute(
				"save",
				{ value: "workerd-process-secret" },
				{ method: "POST", url: "/api/settings", headers: {} },
			),
		).resolves.toEqual({
			settings: "workerd-process-secret",
			alias: "workerd-process-secret",
		});
		const row = await db
			.selectFrom("options" as any)
			.select("value" as any)
			.where("name" as any, "=", "plugin:test-settings:settings:apiKey")
			.executeTakeFirst();
		expect(row?.value).not.toContain("workerd-process-secret");
		expect(JSON.parse(row!.value)).toMatchObject({ v: 1, kid: expect.any(String) });
	}, 30_000);

	it("provides plugin-scoped cron through the production workerd bridge", async () => {
		const plugin = await runner.load(
			{
				id: "test-cron",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		await expect(
			plugin.invokeRoute("cron-test", {}, { method: "POST", url: "/api/cron", headers: {} }),
		).resolves.toEqual([expect.objectContaining({ name: "daily", schedule: "@daily" })]);
		expect(
			await db
				.selectFrom("_emdash_cron_tasks" as any)
				.select("plugin_id" as any)
				.executeTakeFirst(),
		).toMatchObject({ plugin_id: "test-cron" });
	}, 30_000);

	it("preserves versioned values and conditional results through the generated worker", async () => {
		const plugin = await runner.load(
			{
				id: "test-conditional",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
			},
			ECHO_PLUGIN,
		);
		const result = await plugin.invokeRoute(
			"conditional-test",
			{},
			{
				method: "POST",
				url: "/api/conditional",
				headers: {},
			},
		);
		expect(result).toEqual(
			[0, 1].map(() => ({
				created: { applied: true, revision: expect.any(String) },
				saved: { value: null, revision: expect.any(String) },
				conflict: { applied: false },
				updated: { applied: true, revision: expect.any(String) },
				staleDelete: { applied: false },
				deleted: { applied: true },
				missing: null,
			})),
		);
	}, 30_000);

	it("runs guarded decrements through the generated worker", async () => {
		const plugin = await runner.load(
			{
				id: "test-update-if",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: ["stock"] } },
			},
			UPDATE_IF_PLUGIN,
		);
		const result = await plugin.invokeRoute(
			"reserve",
			{},
			{
				method: "POST",
				url: "/api/reserve",
				headers: {},
			},
		);
		expect(result).toEqual({
			outcomes: expect.arrayContaining([
				{ applied: true, data: { stock: 1, title: "retained" } },
				{ applied: true, data: { stock: 0, title: "retained" } },
				{ applied: false },
				{ applied: false },
			]),
			saved: { stock: 0, title: "retained" },
		});
	}, 30_000);

	it("reconstructs safe storage retry metadata through the generated worker", async () => {
		const updates = new WeakSet<QueryId>();
		runner = new WorkerdSandboxRunner({
			db: db.withPlugin({
				transformQuery: ({ node, queryId }) => {
					if (node.kind === "UpdateQueryNode") updates.add(queryId);
					return node;
				},
				transformResult: async ({ result, queryId }) => {
					if (updates.has(queryId)) {
						throw Object.assign(new Error("private SQL and parameters"), { code: "40P01" });
					}
					return result;
				},
			}),
		});
		const plugin = await runner.load(
			{
				id: "test-update-retry",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
			},
			UPDATE_IF_PLUGIN,
		);
		expect(
			await plugin.invokeRoute(
				"retry",
				{},
				{
					method: "POST",
					url: "/api/retry",
					headers: {},
				},
			),
		).toEqual({
			name: "StorageSerializationError",
			code: "STORAGE_SERIALIZATION_FAILURE",
			retryable: true,
			sqlState: "40P01",
			hasCause: false,
			message:
				"Storage write must be retried. Restart the transaction before retrying when using an explicit transaction.",
		});
	}, 30_000);

	it("reloads the updated settings schema with a new plugin version", async () => {
		vi.stubEnv(
			"EMDASH_ENCRYPTION_KEY",
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		const plugin1 = await runner.load(
			{
				id: "test-reload",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		// Invoke to verify it works
		const result1 = (await plugin1.invokeRoute(
			"echo",
			{ v: 1 },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;
		expect(result1.input.v).toBe(1);

		// Unload
		await plugin1.terminate();

		// Reload with new version
		const plugin2 = await runner.load(
			{
				id: "test-reload",
				version: "2.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				admin: { settingsSchema: { apiKey: { type: "secret", label: "API key" } } },
			},
			SETTINGS_PLUGIN,
		);

		const result2 = (await plugin2.invokeRoute(
			"save",
			{ value: "updated-schema-secret" },
			{
				method: "POST",
				url: "/api/test",
				headers: {},
			},
		)) as any;
		expect(result2.settings).toBe("updated-schema-secret");
		const stored = await db
			.selectFrom("options" as any)
			.select("value" as any)
			.where("name" as any, "=", "plugin:test-reload:settings:apiKey")
			.executeTakeFirst();
		expect(stored?.value).not.toContain("updated-schema-secret");
		expect(JSON.parse(stored!.value)).toMatchObject({ v: 1, kid: expect.any(String) });
	}, 60_000);

	it("enforces wall-time limit", async () => {
		const slowRunner = new WorkerdSandboxRunner({
			db,
			limits: { wallTimeMs: 2000 },
		});

		try {
			const plugin = await slowRunner.load(
				{
					id: "test-slow",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
				},
				SLOW_PLUGIN,
			);

			await expect(
				plugin.invokeRoute(
					"slow",
					{},
					{
						method: "POST",
						url: "/api/test",
						headers: {},
					},
				),
			).rejects.toThrow(/exceeded wall-time limit/);
		} finally {
			await slowRunner.terminateAll();
		}
	}, 30_000);

	it("releases a publication invocation that mutates and outlives the wall limit", async () => {
		const contentActions = {
			begin: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
			publish: vi.fn().mockResolvedValue({
				item: {
					id: "post-1",
					type: "posts",
					slug: "post-1",
					status: "published",
					locale: "en",
					data: {},
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					publishedAt: "2026-01-01T00:00:00.000Z",
				},
				_rev: "revision-2",
			}),
		};
		const hangingRunner = new WorkerdSandboxRunner({
			db,
			limits: { wallTimeMs: 200 },
			contentActions: contentActions as never,
		});

		try {
			const plugin = await hangingRunner.load(
				{
					id: "test-publication-hang",
					version: "1.0.0",
					capabilities: ["content:publish"],
					allowedHosts: [],
					storage: {},
				},
				CONTENT_ACTION_HANG_PLUGIN,
			);
			const invalidateContentCache = vi.fn().mockResolvedValue(undefined);

			await expect(
				plugin.invokeRoute(
					"publish-hang",
					{},
					{ method: "POST", url: "/api/test", headers: {} },
					{ invalidateContentCache },
				),
			).rejects.toThrow(/exceeded wall-time limit/);

			expect(contentActions.publish).toHaveBeenCalledOnce();
			const invocationId = contentActions.begin.mock.calls[0]?.[1];
			expect(contentActions.begin).toHaveBeenCalledWith(
				"test-publication-hang",
				invocationId,
				invalidateContentCache,
			);
			expect(contentActions.publish.mock.calls[0]?.[4]).toBe(invocationId);
			expect(contentActions.flush).toHaveBeenCalledWith(
				"test-publication-hang",
				invocationId,
				false,
			);
		} finally {
			await hangingRunner.terminateAll();
		}
	}, 30_000);

	it("preserves a content-write fence through the sandbox route transport", async () => {
		const fencedRunner = new WorkerdSandboxRunner({
			db,
			beforeContentWrite: async () => {
				throw createSandboxRouteError("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
			},
		});

		try {
			const plugin = await fencedRunner.load(
				{
					id: "test-content-write",
					version: "1.0.0",
					capabilities: ["content:write"],
					allowedHosts: [],
					storage: {},
				},
				CONTENT_WRITE_PLUGIN,
			);

			await expect(
				plugin.invokeRoute(
					"write",
					{},
					{
						method: "POST",
						url: "/api/test",
						headers: {},
					},
				),
			).rejects.toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
				status: 503,
			});
		} finally {
			await fencedRunner.terminateAll();
		}
	}, 30_000);

	it("loads multiple plugins simultaneously", async () => {
		const plugin1 = await runner.load(
			{
				id: "test-multi-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const plugin2 = await runner.load(
			{
				id: "test-multi-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			},
			ECHO_PLUGIN,
		);

		const [r1, r2] = (await Promise.all([
			plugin1.invokeRoute(
				"echo",
				{ from: "a" },
				{
					method: "POST",
					url: "/api/test",
					headers: {},
				},
			),
			plugin2.invokeRoute(
				"echo",
				{ from: "b" },
				{
					method: "POST",
					url: "/api/test",
					headers: {},
				},
			),
		])) as any[];

		expect(r1.input.from).toBe("a");
		expect(r2.input.from).toBe("b");
	}, 30_000);
});
