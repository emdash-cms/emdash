import type { KyselyPlugin } from "kysely";
import { expect, it, beforeEach, afterEach, vi } from "vitest";

import {
	PLUGIN_STATE_GENERATION_OPTION,
	PluginStateRepository,
} from "../../../src/plugins/state.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("Plugin state generation", (dialect) => {
	let ctx: DialectTestContext;
	let repo: PluginStateRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new PluginStateRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("treats a missing generation as zero and snapshots an empty table", async () => {
		expect(await repo.getGeneration()).toBe(0n);
		expect(await repo.getSnapshot()).toEqual({ generation: 0n, states: [] });
	});

	it("strictly bumps for every successful state write", async () => {
		let generation = 0n;
		const assertBumped = async (write: () => Promise<unknown>) => {
			await write();
			generation += 1n;
			expect(await repo.getGeneration()).toBe(generation);
		};

		await assertBumped(() => repo.upsert("plugin", "1.0.0", "inactive"));
		await assertBumped(() => repo.upsert("plugin", "1.1.0", "active"));
		await assertBumped(() => repo.enable("plugin", "1.2.0"));
		await assertBumped(() => repo.disable("plugin", "1.2.0"));
		await assertBumped(() => repo.createActiveIfAbsent("another", "1.0.0", "registry"));

		const state = await repo.get("plugin");
		expect(state).not.toBeNull();
		await assertBumped(() => repo.restoreIfVersion("1.2.0", state!));
		await assertBumped(() => repo.delete("plugin"));
		expect((await repo.getSnapshot()).states).toHaveLength(1);
	});

	it("does not bump for conditional no-op create, restore, or delete", async () => {
		await repo.createActiveIfAbsent("plugin", "1.0.0", "registry");
		const before = await repo.getGeneration();
		expect(await repo.createActiveIfAbsent("plugin", "2.0.0", "registry")).toBe(false);

		const state = (await repo.get("plugin"))!;
		expect(await repo.restoreIfVersion("wrong", state)).toBe(false);
		expect(await repo.delete("plugin", { version: "wrong" })).toBe(false);
		expect(await repo.getGeneration()).toBe(before);
	});

	it("does not delete a newer conditional version", async () => {
		await repo.upsert("plugin", "2.0.0", "active", { source: "registry" });
		const before = await repo.getGeneration();
		expect(await repo.delete("plugin", { version: "1.0.0", source: "registry" })).toBe(false);
		expect(await repo.get("plugin")).not.toBeNull();
		expect(await repo.getGeneration()).toBe(before);
	});

	it("keeps a positive generation after the last state is deleted", async () => {
		await repo.upsert("plugin", "1.0.0", "active");
		await repo.delete("plugin");
		expect(await repo.getSnapshot()).toEqual({ generation: 2n, states: [] });
	});

	it("exposes its write receipt to a new repository on the same database", async () => {
		await repo.upsert("plugin", "1.0.0", "active");
		const other = new PluginStateRepository(ctx.db);
		expect(other.getLastWrittenGeneration()).toBe(1n);
		expect(other.getLastWrittenGeneration()).toBe(await other.getGeneration());
	});

	it("does not share write receipts between databases", async () => {
		const otherContext = await setupForDialect(dialect);
		try {
			const other = new PluginStateRepository(otherContext.db);
			await repo.upsert("plugin", "1.0.0", "active");
			expect(repo.getLastWrittenGeneration()).toBe(1n);
			expect(other.getLastWrittenGeneration()).toBeUndefined();
		} finally {
			await teardownForDialect(otherContext);
		}
	});

	it("keeps the UUID option revision separate from the numeric generation", async () => {
		await repo.upsert("plugin", "1.0.0", "active");
		const first = await ctx.db
			.selectFrom("options")
			.select(["value", "revision"])
			.where("name", "=", PLUGIN_STATE_GENERATION_OPTION)
			.executeTakeFirstOrThrow();
		await repo.upsert("plugin", "2.0.0", "active");
		const second = await ctx.db
			.selectFrom("options")
			.select(["value", "revision"])
			.where("name", "=", PLUGIN_STATE_GENERATION_OPTION)
			.executeTakeFirstOrThrow();
		expect(first.value).toBe("1");
		expect(second.value).toBe("2");
		expect(second.revision).not.toBe(first.revision);
		expect(second.revision).not.toBe(second.value);
	});

	it("keeps a snapshot's generation paired with its state across a concurrent write", async () => {
		await repo.upsert("plugin", "1.0.0", "active");
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pausedQueries = new Set<unknown>();
		let paused = false;
		const snapshotDb = ctx.db.withPlugin({
			transformQuery: ({ node, queryId }) => {
				const query = ctx.db.getExecutor().compileQuery(node, queryId);
				if (query.sql.includes("_plugin_state")) pausedQueries.add(queryId);
				return node;
			},
			async transformResult({ result, queryId }) {
				if (pausedQueries.has(queryId)) {
					paused = true;
					await released;
				}
				return result;
			},
		} satisfies KyselyPlugin);
		const snapshot = new PluginStateRepository(snapshotDb).getSnapshot();
		try {
			await vi.waitFor(() => expect(paused).toBe(true));
			await repo.upsert("plugin", "2.0.0", "active");
			expect(await repo.getGeneration()).toBe(2n);
			release();
			expect(await snapshot).toMatchObject({ generation: 1n, states: [{ version: "1.0.0" }] });
		} finally {
			release();
			await snapshot;
		}
	});

	it("does not lose concurrent increments for different plugin ids", async () => {
		const count = 12;
		const results = await Promise.all(
			Array.from({ length: count }, (_, index) =>
				repo.createActiveIfAbsent(`plugin-${index}`, "1.0.0", "registry"),
			),
		);
		expect(results.every(Boolean)).toBe(true);
		expect(await repo.getGeneration()).toBe(BigInt(count));
		expect((await repo.getSnapshot()).states).toHaveLength(count);
	});

	it("rolls back state changes instead of resetting a malformed generation", async () => {
		await repo.upsert("plugin", "1.0.0", "active");
		await ctx.db
			.updateTable("options")
			.set({ value: "broken" })
			.where("name", "=", PLUGIN_STATE_GENERATION_OPTION)
			.execute();
		await expect(repo.upsert("plugin", "2.0.0", "active")).rejects.toThrow();
		expect(await repo.get("plugin")).toMatchObject({ version: "1.0.0" });
		await expect(repo.getGeneration()).rejects.toThrow("Invalid plugin state generation");
	});

	it("throws on malformed stored generations instead of resetting them", async () => {
		await ctx.db
			.insertInto("options")
			.values({
				name: PLUGIN_STATE_GENERATION_OPTION,
				value: "not-a-number",
				revision: crypto.randomUUID(),
			})
			.execute();
		await expect(repo.getGeneration()).rejects.toThrow("Invalid plugin state generation");
		await expect(repo.getSnapshot()).rejects.toThrow("Invalid plugin state generation");
	});
});
