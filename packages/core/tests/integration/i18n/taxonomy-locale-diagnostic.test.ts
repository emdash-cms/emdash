import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { warnAboutUnconfiguredTaxonomyLocales } from "../../../src/i18n/taxonomy-locale-diagnostic.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("taxonomy locale diagnostic", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	it("reports definition and term locales outside the configured locales", async () => {
		const definitionId = ulid();
		const termId = ulid();
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: definitionId,
				name: "topics",
				label: "Topics",
				label_singular: "Topic",
				hierarchical: 0,
				collections: "[]",
				locale: "ja",
				translation_group: definitionId,
			})
			.execute();
		await ctx.db
			.insertInto("taxonomies")
			.values({
				id: termId,
				name: "category",
				slug: "actualites",
				label: "Actualités",
				parent_id: null,
				data: null,
				locale: "fr",
				translation_group: termId,
			})
			.execute();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await warnAboutUnconfiguredTaxonomyLocales(ctx.db, ["en"]);

		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("definitions: ja; terms: fr"));
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("repairing-taxonomy-locale-mismatches"),
		);
	});

	it("treats English as the supported locale when i18n is not configured", async () => {
		const definitionId = ulid();
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: definitionId,
				name: "topics",
				label: "Topics",
				label_singular: "Topic",
				hierarchical: 0,
				collections: "[]",
				locale: "ja",
				translation_group: definitionId,
			})
			.execute();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await warnAboutUnconfiguredTaxonomyLocales(ctx.db, []);

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("configured locales (en)"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("definitions: ja"));
	});

	it("stays silent when every taxonomy row uses a configured locale", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		await warnAboutUnconfiguredTaxonomyLocales(ctx.db, ["en", "ja"]);

		expect(warn).not.toHaveBeenCalled();
	});
});
