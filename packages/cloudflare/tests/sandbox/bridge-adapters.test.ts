import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

const workerEnv = vi.hoisted(() => ({}) as Record<string, unknown>);

vi.mock("cloudflare:workers", () => ({
	env: workerEnv,
	// eslint-disable-next-line typescript/no-extraneous-class -- Workers runtime base class
	DurableObject: class {},
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("virtual:emdash/dialect", async () => {
	const d1 = await import("../../src/db/d1.js");
	const doSql = await import("../../src/db/do-sql.js");
	type Config = { binding: string; name?: string; session?: "disabled" | "auto" };
	return {
		createDialect: (config: Config) =>
			config.name ? doSql.createDialect(config) : d1.createDialect(config),
		createRequestScopedDb: (options: {
			config: Config;
			isAuthenticated: boolean;
			isWrite: boolean;
			cookies: { get: () => undefined; set: () => void };
			url: URL;
		}) =>
			options.config.name
				? doSql.createRequestScopedDb(options)
				: d1.createRequestScopedDb(options),
	};
});

import { PluginBridge } from "../../src/sandbox/bridge.js";
import { BRIDGE_TEST_SCHEMA } from "./bridge-test-schema.js";

type Sqlite = DatabaseSync;

function isSQLInputValue(value: unknown): value is SQLInputValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		ArrayBuffer.isView(value)
	);
}

function sqlParams(values: unknown[]): SQLInputValue[] {
	if (!values.every(isSQLInputValue)) throw new TypeError("invalid SQLite parameter");
	return values;
}

type Statement = {
	params: unknown[];
	bind: (...params: unknown[]) => Statement;
	all: () => Promise<{ results: Record<string, unknown>[]; meta: { changes: number | bigint } }>;
	first: () => Promise<Record<string, unknown> | null>;
	run: () => Promise<{ meta: { changes: number | bigint } }>;
};

function statement(db: Sqlite, query: string): Statement {
	let params: unknown[] = [];
	const bound = () => db.prepare(query);
	return {
		params,
		bind(...values) {
			params = values;
			this.params = values;
			return this;
		},
		async all() {
			const result = bound().all(...sqlParams(params)) as Record<string, unknown>[];
			const changes = Number(db.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
			return { results: result, meta: { changes } };
		},
		async first() {
			return (bound().get(...sqlParams(params)) as Record<string, unknown> | undefined) ?? null;
		},
		async run() {
			const result = bound().run(...sqlParams(params));
			return { meta: { changes: Number(result.changes) } };
		},
	};
}

type D1TestBinding = {
	prepare(query: string): Statement;
	batch(statements: Statement[]): Promise<unknown>;
};

type DoTestStub = {
	query(query: string, params?: unknown[], options?: { primary?: boolean }): Promise<unknown>;
	batchQuery(
		items: Array<{ sql: string; params?: unknown[] }>,
		options?: { primary?: boolean },
	): Promise<unknown>;
};

type DoTestNamespace = {
	calls: Array<{ sql: string; primary?: boolean }>;
	stubCount: number;
	idFromName(name: string): string;
	get(): DoTestStub;
};

function isDoTestNamespace(binding: D1TestBinding | DoTestNamespace): binding is DoTestNamespace {
	return "stubCount" in binding;
}

function d1Binding(db: Sqlite): D1TestBinding {
	return {
		prepare(query: string) {
			return statement(db, query);
		},
		async batch(statements: Statement[]) {
			return Promise.all(statements.map((item) => item.all()));
		},
	};
}

function doNamespace(db: Sqlite): DoTestNamespace {
	const calls: Array<{ sql: string; primary?: boolean }> = [];
	let stubs = 0;
	return {
		calls,
		get stubCount() {
			return stubs;
		},
		idFromName: () => "plugin-db",
		get() {
			stubs++;
			return {
				async query(query: string, params: unknown[] = [], options?: { primary?: boolean }) {
					calls.push({ sql: query, primary: options?.primary });
					const result = db.prepare(query);
					const values = sqlParams(params);
					if (result.columns().length > 0) {
						return { rows: result.all(...values), changes: undefined };
					}
					return { rows: [], changes: Number(result.run(...values).changes), bookmark: "b" };
				},
				async batchQuery(
					items: Array<{ sql: string; params?: unknown[] }>,
					options?: { primary?: boolean },
				) {
					return Promise.all(items.map((item) => this.query(item.sql, item.params ?? [], options)));
				},
			};
		},
	};
}

function schema(db: Sqlite) {
	db.exec(BRIDGE_TEST_SCHEMA);
}

function props(database: unknown) {
	return {
		props: {
			pluginId: "adapter-test",
			pluginVersion: "1.0.0",
			capabilities: [
				"content:read",
				"content:write",
				"media:read",
				"media:write",
				"media:metadata:write",
			],
			allowedHosts: [],
			storageCollections: ["items"],
			database,
		},
	};
}

function makeBridge(database: unknown, env: unknown) {
	return new PluginBridge(props(database) as never, env as never);
}

afterEach(() => {
	for (const key of Object.keys(workerEnv)) delete workerEnv[key];
});

describe("PluginBridge configured database adapters", () => {
	it.each([
		["d1", "@emdash-cms/cloudflare/db/d1"],
		["do-sql", "@emdash-cms/cloudflare/db/do-sql"],
	] as const)("uses the host database for %s storage and KV", async (kind, entrypoint) => {
		const db = new DatabaseSync(":memory:");
		schema(db);
		const decoy = {
			prepare: () => {
				throw new Error("decoy DB was accessed");
			},
		};
		const binding = kind === "d1" ? d1Binding(db) : doNamespace(db);
		const config =
			kind === "d1"
				? { binding: "SITE_DATABASE", session: "disabled" }
				: { binding: "SITE_DATABASE", name: "site", session: "disabled" };
		const descriptor = { entrypoint, config, type: "sqlite" };
		workerEnv.SITE_DATABASE = binding;
		workerEnv.DB = decoy;
		const bridge = makeBridge(descriptor, { DB: decoy });

		await bridge.storagePut("items", "one", { answer: 42 });
		expect(await bridge.storageGet("items", "one")).toEqual({ answer: 42 });
		const stored = db.prepare("SELECT data FROM _plugin_storage WHERE id = 'one'").get() as {
			data: string;
		};
		expect(JSON.parse(stored.data)).toEqual({ answer: 42 });

		await bridge.kvSet("colour", "blue");
		expect(await bridge.kvGet("colour")).toBe("blue");
		const versioned = await bridge.kvGetVersioned("colour");
		expect(versioned?.value).toBe("blue");
		const changed = await bridge.kvCompareAndSet("colour", versioned!.revision, "green");
		expect(changed.applied).toBe(true);
		expect(await bridge.kvGet("colour")).toBe("green");
		const current = await bridge.kvGetVersioned("colour");
		expect((await bridge.kvCompareAndDelete("colour", current!.revision)).applied).toBe(true);
		expect(await bridge.kvGet("colour")).toBeNull();

		await bridge.storagePut("items", "cas", { value: 1 });
		const storedVersion = await bridge.storageGetVersioned("items", "cas");
		expect(storedVersion).not.toBeNull();
		expect((await bridge.storageCompareAndSet("items", "cas", "stale", { value: 2 })).applied).toBe(
			false,
		);
		const updated = await bridge.storageCompareAndSet("items", "cas", storedVersion!.revision, {
			value: 2,
		});
		expect(updated.applied).toBe(true);
		expect(await bridge.storageGet("items", "cas")).toEqual({ value: 2 });
		expect((await bridge.storageCompareAndDelete("items", "cas", "stale")).applied).toBe(false);
		expect(updated.applied).toBe(true);
		if (!updated.applied) throw new Error("storage CAS unexpectedly failed");
		expect((await bridge.storageCompareAndDelete("items", "cas", updated.revision)).applied).toBe(
			true,
		);
		expect(await bridge.storageGet("items", "cas")).toBeNull();
		expect(await bridge.storageDelete("items", "missing")).toBe(false);

		await bridge.settingsSet("timezone", "UTC");
		expect(await bridge.settingsGet("timezone")).toBe("UTC");
		const setting = await bridge.settingsGetVersioned("timezone");
		expect(setting?.value).toBe("UTC");
		expect((await bridge.settingsCompareAndSet("timezone", "stale", "PST")).applied).toBe(false);
		expect((await bridge.settingsCompareAndSet("timezone", setting!.revision, "PST")).applied).toBe(
			true,
		);
		expect(await bridge.settingsGet("timezone")).toBe("PST");
		expect(await bridge.settingsDelete("timezone")).toBe(true);
		expect(await bridge.settingsGet("timezone")).toBeNull();

		const created = await bridge.contentCreate(
			"posts",
			{ slug: "bonjour", title: "Bonjour" },
			{ locale: "en" },
		);
		if ("__emdashContentCreateError" in created) throw new Error(created.error.message);
		expect(await bridge.contentGet("posts", created.id)).toMatchObject({
			data: { title: "Bonjour" },
			locale: "en",
		});
		expect(db.prepare("SELECT title FROM ec_posts WHERE id = ?").get(created.id)?.title).toBe(
			"Bonjour",
		);
		db.exec("DROP TABLE _emdash_collections");
		expect(await bridge.contentGet("posts", created.id)).toMatchObject({
			data: { title: "Bonjour" },
		});
		expect(await bridge.contentDelete("posts", created.id)).toBe(true);
		expect(await bridge.contentGet("posts", created.id)).toBeNull();

		db.prepare(
			"INSERT INTO media (id, filename, mime_type, size, storage_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("image", "test.png", "image/png", 10, "test.png", "ready", new Date().toISOString());
		expect(await bridge.mediaGet("image")).toMatchObject({ id: "image", filename: "test.png" });
		await bridge.mediaUpdateMetadata("image", { alt: "A test image" });
		expect(db.prepare("SELECT alt FROM media WHERE id = 'image'").get()?.alt).toBe("A test image");
		expect(await bridge.mediaDelete("image")).toBe(true);
		expect(await bridge.mediaGet("image")).toBeNull();

		if (isDoTestNamespace(binding)) {
			expect(binding.stubCount).toBeGreaterThan(1);
			expect(
				binding.calls
					.filter((call) => /^(select|pragma)/i.test(call.sql.trim()))
					.every((call) => call.primary === true),
			).toBe(true);
		}
		db.close();
	});
});
