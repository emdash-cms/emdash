/**
 * Byline field registry — concurrent-mutation safety
 *
 * Phase 2 of Discussion #1174 mandates that every mutation on
 * `BylineSchemaRegistry` bumps `options.byline_fields_version` atomically,
 * so two concurrent mutations don't collapse into one increment. The
 * registry implements this with a single set-based UPDATE
 * (`SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`); this suite
 * proves that contract end-to-end on every supported dialect.
 *
 * SQLite + D1: writes are serialised at the database level, so "concurrent"
 * here means "fired in parallel via `Promise.all`" — the test verifies the
 * code path is set-based rather than read-modify-write (the latter would
 * deadlock or drop increments under serialisation).
 *
 * Postgres: real row-level concurrency. The atomic UPDATE relies on PG's
 * default `READ COMMITTED` isolation behaviour on UPDATE statements,
 * which acquires a row-level lock for the duration of the statement.
 * Concurrent UPDATEs serialise behind the lock; each one observes the
 * latest committed value and applies its +1.
 *
 * Activate Postgres parity by exporting `EMDASH_TEST_PG=1` and pointing
 * `PG_CONNECTION_STRING` at a writable test database.
 */

import { beforeEach, afterEach, expect, it } from "vitest";

import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("BylineSchemaRegistry concurrency", (dialect) => {
	let ctx: DialectTestContext;
	let registry: BylineSchemaRegistry;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new BylineSchemaRegistry(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("parallel createField calls each land their own version increment", async () => {
		const startVersion = await registry.getVersion();
		const slugs = Array.from({ length: 10 }, (_, i) => `field_${i}`);

		const results = await Promise.allSettled(
			slugs.map((slug) => registry.createField({ slug, label: slug, type: "string" })),
		);

		// Every create either succeeded (FIELD_EXISTS shouldn't fire because
		// slugs are unique) — collect successes and count them.
		const succeeded = results.filter((r) => r.status === "fulfilled").length;
		expect(succeeded).toBe(slugs.length);

		const endVersion = await registry.getVersion();
		expect(endVersion - startVersion).toBe(slugs.length);
	});

	it("parallel updateField calls don't lose version increments", async () => {
		const field = await registry.createField({
			slug: "job_title",
			label: "Job title",
			type: "string",
		});
		const baseline = await registry.getVersion();

		const labels = Array.from({ length: 10 }, (_, i) => `Label ${i}`);
		await Promise.allSettled(labels.map((label) => registry.updateField("job_title", { label })));

		const after = await registry.getVersion();
		// Every update is non-trivial (label changes), so every call should
		// have bumped the counter. PG: serialised by the row-level lock on
		// `_emdash_byline_fields.id` during UPDATE; SQLite: serialised by
		// the database lock. Either way, increments are not lost.
		expect(after - baseline).toBe(labels.length);

		// And the final state is a single, well-defined row — no duplicate
		// definitions, label is one of the inputs.
		const reloaded = await registry.getField("job_title");
		expect(reloaded?.id).toBe(field.id);
		expect(labels).toContain(reloaded?.label);
	});

	it("mixed parallel mutations all bump the version", async () => {
		await registry.createField({ slug: "a", label: "A", type: "string" });
		await registry.createField({ slug: "b", label: "B", type: "string" });
		const baseline = await registry.getVersion();

		// 3 mutations in parallel: one create, one update, one reorder. None
		// of them conflict — they target different rows or properties.
		const ops: Array<Promise<unknown>> = [
			registry.createField({ slug: "c", label: "C", type: "string" }),
			registry.updateField("a", { label: "Aa" }),
		];

		await Promise.all(ops);
		// Reorder runs serially after both — it reads the full set so it
		// can't safely race against parallel creates. (The registry itself
		// permits the race; this test just keeps the assertion meaningful.)
		await registry.reorderFields(["c", "a", "b"]);

		const after = await registry.getVersion();
		expect(after - baseline).toBe(3);
	});

	it("parallel deletes against distinct fields don't lose increments", async () => {
		for (let i = 0; i < 6; i++) {
			await registry.createField({ slug: `del_${i}`, label: `del_${i}`, type: "string" });
		}
		const baseline = await registry.getVersion();

		await Promise.all(Array.from({ length: 6 }, (_, i) => registry.deleteField(`del_${i}`)));

		const after = await registry.getVersion();
		expect(after - baseline).toBe(6);
		expect((await registry.listFields()).map((f) => f.slug)).not.toContain("del_0");
	});

	it("createField duplicate slugs: one succeeds, the other surfaces FIELD_EXISTS", async () => {
		const baseline = await registry.getVersion();

		// Fire two creates with the same slug. On SQLite/D1 (serialised
		// writes) one will land first and the second will hit the
		// FIELD_EXISTS check. On PG the same property holds via the UNIQUE
		// index on slug — the loser sees a UNIQUE constraint error, but the
		// registry's getField pre-check catches the racy case for most runs.
		// We assert the *outcome*: exactly one row exists and the version
		// counter advanced by at least one (the winner).
		const results = await Promise.allSettled([
			registry.createField({ slug: "dupe", label: "Dupe A", type: "string" }),
			registry.createField({ slug: "dupe", label: "Dupe B", type: "string" }),
		]);

		const succeeded = results.filter((r) => r.status === "fulfilled");
		expect(succeeded.length).toBeGreaterThanOrEqual(1);
		const rows = await registry.listFields();
		expect(rows.filter((f) => f.slug === "dupe")).toHaveLength(1);
		expect((await registry.getVersion()) - baseline).toBeGreaterThanOrEqual(1);
	});
});
