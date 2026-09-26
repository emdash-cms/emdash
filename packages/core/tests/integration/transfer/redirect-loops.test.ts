/**
 * An origin can hold an enabled redirect loop (enabling a redirect does not
 * run the loop check). A package with more redirects than analysis checks
 * for loops still imports: the importer writes a redirect that would close
 * a loop disabled, and verification expects it that way.
 */

import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { MAX_LOOP_CHECKED_REDIRECTS } from "../../../src/transfer/analyze/target.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { exportOrigin, importPackage, phase, seedTarget, TARGET_BOB } from "./pipeline.js";

const T0 = "2026-01-01T00:00:00.000Z";

function redirect(id: string, source: string, destination: string, enabled: boolean) {
	return {
		id,
		source,
		destination,
		type: 301,
		is_pattern: 0,
		enabled: enabled ? 1 : 0,
		hits: 0,
		auto: 0,
		created_at: T0,
		updated_at: T0,
	};
}

describeEachDialect("importing redirect loops past the analysis limit", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("imports the redirect that closes a loop disabled", { timeout: 600_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const filler = Array.from({ length: MAX_LOOP_CHECKED_REDIRECTS }, (_, index) =>
			redirect(ulid(), `/filler/${index}`, `/landing/${index}`, true),
		);
		for (let start = 0; start < filler.length; start += 500) {
			await source.db
				.insertInto("_emdash_redirects")
				.values(filler.slice(start, start + 500))
				.execute();
		}
		const [first, second] = [ulid(), ulid()].toSorted();
		await source.db
			.insertInto("_emdash_redirects")
			.values([
				redirect(first!, "/loop-a", "/loop-b", true),
				redirect(second!, "/loop-b", "/loop-a", false),
			])
			.execute();
		await source.db
			.updateTable("_emdash_redirects")
			.set({ enabled: 1 })
			.where("id", "=", second!)
			.execute();
		await seedTarget(target.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

		const result = await importPackage(
			target.db,
			createMemoryStorage(),
			await exportOrigin(phase(source.db), originStorage),
			{ principalMappings: { [site.ids.alice]: null, [site.ids.bob]: TARGET_BOB } },
		);
		expect(result.operation.errorDetail).toBeNull();
		expect(result.operation.state).toBe("complete");
		const loop = await sql<{ id: string; enabled: number | boolean }>`
			SELECT id, enabled FROM _emdash_redirects WHERE source LIKE '/loop-%' ORDER BY id
		`.execute(target.db);
		expect(loop.rows.map((row) => [row.id, Number(row.enabled)])).toEqual([
			[first, 1],
			[second, 0],
		]);
		expect(result.operation.receipt?.warnings.map((warning) => warning.code) ?? []).toContain(
			"redirect_loops_unchecked",
		);
	});
});
