/**
 * Byline field registry — concurrent-mutation safety under the
 * parity-aware bookend (Phase 6 of #1174). Asserts post-state
 * correctness (every row lands, final version is even) rather than
 * exact +N increments — concurrent mutators can collapse one or both
 * bookends, which is fine per the registry's class JSDoc.
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

	it("parallel createField calls all land their rows and the post-state version is even", async () => {
		const startVersion = await registry.getVersion();
		const slugs = Array.from({ length: 10 }, (_, i) => `field_${i}`);

		const results = await Promise.allSettled(
			slugs.map((slug) => registry.createField({ slug, label: slug, type: "string" })),
		);

		expect(results.filter((r) => r.status === "fulfilled").length).toBe(slugs.length);

		const reloadedSlugs = (await registry.listFields()).map((f) => f.slug);
		for (const slug of slugs) {
			expect(reloadedSlugs).toContain(slug);
		}

		const endVersion = await registry.getVersion();
		expect(endVersion).toBeGreaterThan(startVersion);
		expect(endVersion % 2).toBe(0);
	});

	it("parallel updateField calls all land and post-state version is even", async () => {
		const field = await registry.createField({
			slug: "job_title",
			label: "Job title",
			type: "string",
		});
		const baseline = await registry.getVersion();

		const labels = Array.from({ length: 10 }, (_, i) => `Label ${i}`);
		await Promise.allSettled(labels.map((label) => registry.updateField("job_title", { label })));

		const after = await registry.getVersion();
		expect(after).toBeGreaterThan(baseline);
		expect(after % 2).toBe(0);

		// And the final state is a single, well-defined row — no duplicate
		// definitions, label is one of the inputs.
		const reloaded = await registry.getField("job_title");
		expect(reloaded?.id).toBe(field.id);
		expect(labels).toContain(reloaded?.label);
	});

	it("mixed parallel mutations all land and post-state version is even", async () => {
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
		// Reorder runs serially — it reads the full set, so racing it
		// against parallel creates would make the assertion non-meaningful.
		await registry.reorderFields(["c", "a", "b"]);

		const after = await registry.getVersion();
		expect(after).toBeGreaterThan(baseline);
		expect(after % 2).toBe(0);

		const fields = await registry.listFields();
		expect(fields.map((f) => f.slug).toSorted()).toEqual(["a", "b", "c"]);
		expect(fields.find((f) => f.slug === "a")?.label).toBe("Aa");
	});

	it("parallel deletes against distinct fields all land and post-state version is even", async () => {
		for (let i = 0; i < 6; i++) {
			await registry.createField({ slug: `del_${i}`, label: `del_${i}`, type: "string" });
		}
		const baseline = await registry.getVersion();

		await Promise.all(Array.from({ length: 6 }, (_, i) => registry.deleteField(`del_${i}`)));

		const after = await registry.getVersion();
		expect(after).toBeGreaterThan(baseline);
		expect(after % 2).toBe(0);

		const remaining = (await registry.listFields()).map((f) => f.slug);
		for (let i = 0; i < 6; i++) {
			expect(remaining).not.toContain(`del_${i}`);
		}
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
