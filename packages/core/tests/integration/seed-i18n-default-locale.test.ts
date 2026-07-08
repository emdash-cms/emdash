import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../src/cli/commands/export-seed.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { applySeed } from "../../src/seed/apply.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

/**
 * Regression for #1421: the seed CLI hardcodes `en` as the default locale.
 *
 * A project whose only authored locale is a non-`en` default (e.g. `de`) is
 * treated as non-i18n by `export-seed` (single distinct locale → no `locale`
 * emitted), and `apply` — running outside the Astro runtime with no i18n
 * config — backfills the missing locale as `en`. The round-trip silently
 * rewrites `de` rows to `en`, breaking locale-scoped runtime lookups.
 *
 * These tests run with the i18n config UNSET (the CLI environment) and assert
 * the data's real default locale survives an export → apply round-trip.
 */
describe("seed round-trip preserves a non-en default locale (#1421)", () => {
	let source: Kysely<Database>;
	let target: Kysely<Database>;

	beforeEach(() => {
		setI18nConfig(null);
	});

	afterEach(async () => {
		if (source) await teardownTestDatabase(source);
		if (target) await teardownTestDatabase(target);
		setI18nConfig(null);
	});

	it("keeps menus, taxonomies, and content at their real default locale", async () => {
		source = await setupTestDatabaseWithCollections();
		const now = new Date().toISOString();

		// A genuine single-locale `de` project: every locale-bearing row is `de`.
		// The built-in taxonomy defs are created at the project default, so move
		// the seeded `category`/`tag` defs to `de` rather than leaving stray `en`
		// rows that would make the data look multi-locale.
		await source.updateTable("_emdash_taxonomy_defs").set({ locale: "de" }).execute();

		// A single-locale `de` project: one menu, one taxonomy def, one post,
		// all in `de`.
		await source
			.insertInto("_emdash_menus")
			.values({
				id: ulid(),
				name: "primary",
				label: "Hauptmenü",
				created_at: now,
				updated_at: now,
				locale: "de",
				translation_group: ulid(),
			})
			.execute();

		await source
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: ulid(),
				name: "genre",
				label: "Kategorien",
				hierarchical: 0,
				collections: JSON.stringify(["post"]),
				created_at: now,
				locale: "de",
				translation_group: ulid(),
			})
			.execute();

		await source
			.insertInto("ec_post")
			.values({
				id: ulid(),
				slug: "hallo",
				status: "published",
				created_at: now,
				updated_at: now,
				version: 1,
				locale: "de",
				translation_group: ulid(),
				title: "Hallo",
			} as never)
			.execute();

		// Export from the CLI environment (i18n config unset).
		const seed = await exportSeed(source, "post");

		// Apply into a fresh DB, also outside the runtime.
		target = await setupTestDatabaseWithCollections();
		await applySeed(target, seed, { includeContent: true });

		const menu = await target
			.selectFrom("_emdash_menus")
			.select("locale")
			.where("name", "=", "primary")
			.executeTakeFirstOrThrow();
		expect(menu.locale).toBe("de");

		const def = await target
			.selectFrom("_emdash_taxonomy_defs")
			.select("locale")
			.where("name", "=", "genre")
			.executeTakeFirstOrThrow();
		expect(def.locale).toBe("de");

		const post = await target
			.selectFrom("ec_post")
			.select("locale")
			.where("slug", "=", "hallo")
			.executeTakeFirstOrThrow();
		expect(post.locale).toBe("de");
	});
});
