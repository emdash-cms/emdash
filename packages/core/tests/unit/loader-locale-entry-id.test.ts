import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("virtual:emdash/config", () => ({
	default: { i18n: { defaultLocale: "de", locales: ["de", "en"], prefixDefaultLocale: false } },
}));

describe("loader entry IDs with a request-scoped database", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		for (const [locale, slug] of [
			["de", "mein-beitrag"],
			["en", "my-post"],
		] as const) {
			const result = await handleContentCreate(db, "post", {
				data: { title: slug },
				slug,
				status: "published",
				locale,
			});
			if (!result.success) throw new Error(result.error.message);
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("prefixes non-default locales the same way as the default database path", async () => {
		const loader = emdashLoader();

		const ids = await runWithContext({ editMode: false, db }, async () => ({
			en: (await loader.loadCollection!({ filter: { type: "post", locale: "en" } })).entries?.map(
				(entry) => entry.id,
			),
			de: (await loader.loadCollection!({ filter: { type: "post", locale: "de" } })).entries?.map(
				(entry) => entry.id,
			),
			entry: (await loader.loadEntry!({ filter: { type: "post", id: "my-post", locale: "en" } }))
				?.id,
		}));

		expect(ids).toEqual({ en: ["en/my-post"], de: ["mein-beitrag"], entry: "en/my-post" });
	});
});
