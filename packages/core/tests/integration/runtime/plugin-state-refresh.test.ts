import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KyselyPlugin, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin, definePluginRoute } from "../../../src/plugins/define-plugin.js";
import type { PluginContext } from "../../../src/plugins/types.js";
import { runWithContext } from "../../../src/request-context.js";

const pluginId = "refreshable-plugin";
const runtimes: EmDashRuntime[] = [];
const paths: string[] = [];

function databasePath() {
	const path = join(tmpdir(), `emdash-plugin-refresh-${randomUUID()}.db`);
	paths.push(path);
	return path;
}

function deps(
	path: string,
	entrypoint: string,
	handlers: { activate: () => void; deactivate: () => void },
	database?: Database,
): RuntimeDependencies {
	return {
		config: { database: { entrypoint, config: {}, type: "sqlite" } },
		plugins: [
			definePlugin({
				id: pluginId,
				version: "1.0.0",
				capabilities: ["media:read"],
				routes: {
					health: definePluginRoute({ public: true, handler: async () => ({ ok: true }) }),
				},
				hooks: {
					"media:afterUpload": async () => {},
					"plugin:activate": async (_event, _ctx: PluginContext) => handlers.activate(),
					"plugin:deactivate": async (_event, _ctx: PluginContext) => handlers.deactivate(),
				},
			}),
		],
		createDialect: () => new SqliteDialect({ database: database ?? new Database(path) }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

async function route(runtime: EmDashRuntime) {
	return runtime.handlePluginApiRoute(
		pluginId,
		"GET",
		"health",
		new Request("https://example.test/health"),
	);
}

async function mediaHook(runtime: EmDashRuntime) {
	return runtime.hooks.runMediaAfterUpload({
		id: "media-1",
		filename: "file.txt",
		mimeType: "text/plain",
		size: 1,
		url: "https://example.test/file.txt",
		createdAt: new Date().toISOString(),
	});
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const runtime of runtimes.splice(0)) {
		await runtime.shutdown();
		await runtime.db.destroy();
	}
	await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe("runtime plugin state refresh", () => {
	it("refreshes an independent warm runtime without replaying lifecycle hooks", async () => {
		const path = databasePath();
		const entrypoint = randomUUID();
		const database = new Database(path);
		const writerActivations = { value: 0 };
		const writerDeactivations = { value: 0 };
		const readerActivations = { value: 0 };
		const readerDeactivations = { value: 0 };
		const writer = await EmDashRuntime.create(
			deps(
				path,
				entrypoint,
				{
					activate: () => writerActivations.value++,
					deactivate: () => writerDeactivations.value++,
				},
				database,
			),
		);
		runtimes.push(writer);
		const reader = await EmDashRuntime.create(
			deps(
				path,
				entrypoint,
				{
					activate: () => readerActivations.value++,
					deactivate: () => readerDeactivations.value++,
				},
				database,
			),
		);
		runtimes.push(reader);
		vi.useFakeTimers({ toFake: ["Date"] });

		const before = await mediaHook(reader);
		expect((await route(reader)).success).toBe(true);
		expect(before).toHaveLength(1);
		await writer.handlePluginDisable(pluginId);
		expect((await route(reader)).success).toBe(true);
		const staleHook = await mediaHook(reader);
		expect(staleHook).toHaveLength(1);

		vi.advanceTimersByTime(5_000);
		await reader.ensurePluginStateFresh();
		expect((await route(reader)).success).toBe(false);
		expect(await mediaHook(reader)).toHaveLength(0);
		expect(readerDeactivations.value).toBe(0);
		expect(writerDeactivations.value).toBe(1);

		await writer.handlePluginEnable(pluginId);
		vi.advanceTimersByTime(5_000);
		await reader.runScheduledTasksWithStats();
		expect((await route(reader)).success).toBe(true);
		expect(await mediaHook(reader)).toHaveLength(1);
		expect(readerActivations.value).toBe(0);
		expect(writerActivations.value).toBe(2);
	}, 15_000);

	it("does not refresh while a disable is waiting for its database write", async () => {
		const path = databasePath();
		const entrypoint = randomUUID();
		const database = new Database(path);
		const lifecycle = { activate: 0, deactivate: 0 };
		const runtime = await EmDashRuntime.create(
			deps(
				path,
				entrypoint,
				{
					activate: () => lifecycle.activate++,
					deactivate: () => lifecycle.deactivate++,
				},
				database,
			),
		);
		runtimes.push(runtime);
		vi.useFakeTimers({ toFake: ["Date"] });

		let releaseUpdate!: () => void;
		const updateCommitted = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		let updateSeen!: () => void;
		const updateStarted = new Promise<void>((resolve) => {
			updateSeen = resolve;
		});
		const updateQueryIds = new Set<unknown>();
		const gatedDb = runtime.db.withPlugin({
			transformQuery: ({ node, queryId }) => {
				if (node.kind === "UpdateQueryNode") {
					updateQueryIds.add(queryId);
					updateSeen();
				}
				return node;
			},
			async transformResult({ queryId, result }) {
				if (updateQueryIds.has(queryId)) await updateCommitted;
				return result;
			},
		} satisfies KyselyPlugin);

		const disable = runWithContext({ editMode: false, db: gatedDb }, () =>
			runtime.handlePluginDisable(pluginId),
		);
		try {
			await updateStarted;
			vi.advanceTimersByTime(5_000);
			let refreshFinished = false;
			const refresh = runtime.ensurePluginStateFresh().then(() => {
				refreshFinished = true;
				return undefined;
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(refreshFinished).toBe(false);
			expect(lifecycle.deactivate).toBe(0);

			releaseUpdate();
			await Promise.all([disable, refresh]);
			expect(lifecycle.deactivate).toBe(1);
			expect(await mediaHook(runtime)).toHaveLength(0);
		} finally {
			releaseUpdate();
			await disable;
		}
	}, 30_000);

	it("coalesces refresh reads and retries after a failed state read", async () => {
		const path = databasePath();
		const entrypoint = randomUUID();
		const database = new Database(path);
		const prepare = vi.spyOn(database, "prepare");
		const stateQueries = () =>
			prepare.mock.calls.filter(([query]) => query.includes('"_plugin_state"')).length;
		const handlers = { activate: () => {}, deactivate: () => {} };
		const writer = await EmDashRuntime.create(deps(path, entrypoint, handlers, database));
		runtimes.push(writer);
		const readerDeps = deps(path, entrypoint, handlers, database);
		const reader = await EmDashRuntime.create(readerDeps);
		runtimes.push(reader);
		vi.useFakeTimers({ toFake: ["Date"] });
		const before = stateQueries();
		vi.advanceTimersByTime(5_000);
		await Promise.all([reader.ensurePluginStateFresh(), reader.ensurePluginStateFresh()]);
		expect(stateQueries() - before).toBe(1);

		await writer.handlePluginDisable(pluginId);
		vi.advanceTimersByTime(5_000);
		database.exec('ALTER TABLE "_plugin_state" RENAME TO "_plugin_state_unavailable"');
		await expect(reader.ensurePluginStateFresh()).rejects.toThrow();
		database.exec('ALTER TABLE "_plugin_state_unavailable" RENAME TO "_plugin_state"');
		const failedReadQueries = stateQueries();
		await expect(reader.ensurePluginStateFresh()).rejects.toThrow();
		expect(stateQueries()).toBe(failedReadQueries);
		vi.advanceTimersByTime(5_000);
		await reader.ensurePluginStateFresh();
		expect((await route(reader)).success).toBe(false);
	}, 15_000);

	it("does not poll sites without plugin sources", async () => {
		const sqlite = new Database(":memory:");
		const runtime = await EmDashRuntime.create({
			config: { database: { entrypoint: randomUUID(), config: {}, type: "sqlite" } },
			plugins: [],
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
		runtimes.push(runtime);
		vi.useFakeTimers({ toFake: ["Date"] });
		const prepare = vi.spyOn(sqlite, "prepare");
		vi.advanceTimersByTime(5_000);
		await runtime.ensurePluginStateFresh();
		expect(prepare.mock.calls.some(([query]) => query.includes('"_plugin_state"'))).toBe(false);
	});
});
