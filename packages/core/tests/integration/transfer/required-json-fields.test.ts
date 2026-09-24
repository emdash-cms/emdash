/**
 * A required JSON field added to a collection that already has entries
 * fills those entries with the column's empty default, JSON `null`. Such
 * entries transfer, and the target stores JSON `null` in the NOT NULL
 * column.
 */

import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";

import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { FieldType } from "../../../src/schema/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { exportOrigin, importPackage, phase, seedTarget, TARGET_BOB } from "./pipeline.js";

const JSON_FIELDS: Array<[string, FieldType]> = [
	["summary", "portableText"],
	["extra", "json"],
	["flavours", "multiSelect"],
	["steps", "repeater"],
];

describeEachDialect("required JSON fields holding their empty default", (dialect) => {
	let source: DialectTestContext | undefined;
	let target: DialectTestContext | undefined;

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(source);
		await teardownForDialect(target);
	});

	it("transfer as JSON null", { timeout: 300_000 }, async () => {
		source = await setupForDialect(dialect);
		target = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(source.db, originStorage);
		const registry = new SchemaRegistry(source.db);
		for (const [slug, type] of JSON_FIELDS) {
			await registry.createField("posts", { slug, label: slug, type, required: true });
		}
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

		const stored = async (context: DialectTestContext) =>
			(
				await sql<Record<string, string | null>>`
					SELECT id, ${sql.join(
						JSON_FIELDS.map(([slug]) =>
							dialect === "postgres"
								? sql`${sql.ref(slug)}::text AS ${sql.ref(slug)}`
								: sql`${sql.ref(slug)}`,
						),
					)}
					FROM ec_posts ORDER BY id
				`.execute(context.db)
			).rows;
		const rows = await stored(target);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			for (const [slug] of JSON_FIELDS) expect(row[slug], slug).toBe("null");
		}
		expect(rows).toEqual(await stored(source));
	});
});
