import { LiveEntryNotFoundError } from "astro/content/runtime";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { normalizeAstroI18n } from "../../../src/i18n/normalize.js";
import type {
	CollectionFilter as EmDashCollectionFilter,
	EntryFilter as EmDashEntryFilter,
} from "../../../src/loader.js";
import { getEmDashCollection, getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type LiveEntryOptions = EmDashEntryFilter;
type LiveCollectionOptions = EmDashCollectionFilter;

vi.mock("astro:content", () => ({
	getLiveEntry: async (_collection: string, options: LiveEntryOptions) => {
		const { emdashLoader } = await import("../../../src/loader.js");
		const loaded = await emdashLoader().loadEntry!({ filter: options });
		if (loaded && !("error" in loaded)) {
			return { entry: loaded, error: undefined };
		}
		return {
			entry: undefined,
			error:
				loaded && "error" in loaded
					? loaded.error
					: new LiveEntryNotFoundError(options.type, options.id),
		};
	},
	getLiveCollection: async (_collection: string, options: LiveCollectionOptions) => {
		const { emdashLoader } = await import("../../../src/loader.js");
		return emdashLoader().loadCollection!({ filter: options });
	},
}));

describeEachDialect("content queries with Astro locale object codes", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: ReturnType<typeof createTestRuntime>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		setI18nConfig(
			normalizeAstroI18n({
				defaultLocale: "es-MX",
				locales: ["es-MX", { path: "en", codes: ["en-US", "en-GB"] }],
				fallback: { en: "es-MX" },
			}),
		);

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	async function createAndPublish(body: {
		title: string;
		slug: string;
		locale?: string;
		translationOf?: string;
	}) {
		const created = await runtime.handleContentCreate("pages", {
			data: { title: body.title },
			slug: body.slug,
			locale: body.locale,
			translationOf: body.translationOf,
		});
		if (!created.success) throw new Error(created.error.message);
		const published = await runtime.handleContentPublish("pages", created.data.item.id);
		if (!published.success) throw new Error(published.error.message);
		return created.data.item;
	}

	it.each(["en-US", "en-GB", "EN-us", "en"])(
		"uses the configured path for rows and Astro code %s for reads",
		async (locale) => {
			const spanish = await createAndPublish({
				title: "Términos ES",
				slug: "terminos-y-condiciones",
				locale: "es-MX",
			});
			await createAndPublish({
				title: "Terms EN",
				slug: "terminos-y-condiciones",
				locale: "en",
				translationOf: spanish.id,
			});

			const byCode = await runWithContext({ editMode: false, db }, () =>
				getEmDashEntry("pages", "terminos-y-condiciones", { locale }),
			);
			expect(byCode.error).toBeUndefined();
			expect(byCode.entry?.data.title).toBe("Terms EN");
			expect(byCode.fallbackLocale).toBeUndefined();

			const fromContext = await runWithContext({ editMode: false, db, locale }, () =>
				getEmDashEntry("pages", "terminos-y-condiciones"),
			);
			expect(fromContext.error).toBeUndefined();
			expect(fromContext.entry?.data.title).toBe("Terms EN");
			expect(fromContext.fallbackLocale).toBeUndefined();

			const collection = await runWithContext({ editMode: false, db, locale }, () =>
				getEmDashCollection("pages"),
			);
			expect(collection.error).toBeUndefined();
			expect(collection.entries).toHaveLength(1);
			expect(collection.entries[0]?.data.title).toBe("Terms EN");

			const explicitCollection = await runWithContext({ editMode: false, db }, () =>
				getEmDashCollection("pages", { locale }),
			);
			expect(explicitCollection.error).toBeUndefined();
			expect(explicitCollection.entries.map((entry) => entry.data.title)).toEqual(["Terms EN"]);

			const editMode = await runWithContext({ editMode: true, db, locale }, () =>
				getEmDashEntry("pages", "terminos-y-condiciones"),
			);
			expect(editMode.error).toBeUndefined();
			expect(editMode.entry?.data.title).toBe("Terms EN");
		},
	);

	it("writes an Astro code alias using its configured path", async () => {
		const spanish = await createAndPublish({
			title: "Solo ES",
			slug: "solo-alias",
			locale: "es-MX",
		});
		await createAndPublish({
			title: "Alias EN",
			slug: "solo-alias",
			locale: "en-GB",
			translationOf: spanish.id,
		});

		const rows = await sql<{ locale: string }>`
			SELECT locale FROM ec_pages WHERE slug = ${"solo-alias"}
		`.execute(db);
		expect(rows.rows.map((row) => row.locale).toSorted()).toEqual(["en", "es-MX"]);
	});

	it("falls back to the default locale when the code has no translation", async () => {
		await createAndPublish({
			title: "Solo ES",
			slug: "solo-espanol",
			locale: "es-MX",
		});

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("pages", "solo-espanol", { locale: "en-US" }),
		);
		expect(result.entry?.data.title).toBe("Solo ES");
		expect(result.fallbackLocale).toBe("es-MX");
	});
});
