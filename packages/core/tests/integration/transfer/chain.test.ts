/**
 * A site imported from a package is itself exported and imported again:
 * credits the first import materialized travel onward as ordinary explicit
 * credits.
 */

import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { inferredCreditId } from "../../../src/transfer/format/kinds.js";
import { INFERRED_CREDIT_ENTITY } from "../../../src/transfer/import/stages.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { exportOrigin, importPackage, phase, seedTarget, TARGET_BOB } from "./pipeline.js";

describeEachDialect("site transfer A → B → C", (dialect) => {
	let contexts: DialectTestContext[] = [];

	afterEach(async () => {
		setI18nConfig(null);
		for (const context of contexts) await teardownForDialect(context);
		contexts = [];
	});

	describe.each([
		["mapped to their suggested users", "suggested"],
		["all unmapped", "unmapped"],
	] as const)("with B's principals %s on C", (_label, mode) => {
		it("verifies the second hop", { timeout: 300_000 }, async () => {
			const a = await setupForDialect(dialect);
			const b = await setupForDialect(dialect);
			const c = await setupForDialect(dialect);
			contexts = [a, b, c];
			const storageA = createMemoryStorage();
			const storageB = createMemoryStorage();
			const storageC = createMemoryStorage();
			const site = await buildOriginSite(a.db, storageA);
			await seedTarget(b.db);
			await seedTarget(c.db);
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

			const first = await importPackage(b.db, storageB, await exportOrigin(phase(a.db), storageA), {
				principalMappings: { [site.ids.alice]: null, [site.ids.bob]: TARGET_BOB },
			});
			expect(first.operation.errorDetail).toBeNull();
			expect(first.operation.state).toBe("complete");
			const materialized = await b.db
				.selectFrom("_emdash_content_bylines")
				.select("id")
				.where("id", "like", "inferred:%")
				.execute();
			expect(materialized.map((row) => row.id)).toContain(
				inferredCreditId("pages", site.ids.about),
			);
			if (mode === "unmapped") {
				// The credited entry gets an author who owns its byline, so on C its credit
				// could also be inferred; the package's explicit credit must win.
				await b.db
					.updateTable("_emdash_bylines")
					.set({ user_id: TARGET_BOB })
					.where("id", "=", site.ids.aliceEn)
					.execute();
				await sql`UPDATE ec_pages SET author_id = ${TARGET_BOB} WHERE id = ${site.ids.about}`.execute(
					b.db,
				);
			}

			const second = await importPackage(
				c.db,
				storageC,
				await exportOrigin(phase(b.db), storageB),
				mode === "unmapped" ? { principalMappings: { [TARGET_BOB]: null } } : {},
			);
			expect(second.operation.errorDetail).toBeNull();
			expect(second.operation.state).toBe("complete");

			const credits = async (context: DialectTestContext) =>
				(
					await context.db
						.selectFrom("_emdash_content_bylines")
						.select(["id", "collection_slug", "content_id", "byline_id", "sort_order"])
						.orderBy("id")
						.execute()
				).map((row) => ({ ...row, sort_order: Number(row.sort_order) }));
			const recorded = new Set(
				(
					await c.db
						.selectFrom("_emdash_transfer_identity_map")
						.select("portable_id")
						.where("operation_id", "=", second.operation.id)
						.where("entity_kind", "=", INFERRED_CREDIT_ENTITY)
						.execute()
				).map((row) => row.portable_id),
			);
			expect(recorded.has(inferredCreditId("pages", site.ids.about))).toBe(false);
			expect(recorded.size > 0).toBe(mode === "unmapped");
			expect((await credits(c)).filter((credit) => !recorded.has(credit.id))).toEqual(
				await credits(b),
			);
		});
	});
});
