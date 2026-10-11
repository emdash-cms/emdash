import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/well-known/auth.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { SiteSettingsRepository } from "../../../src/database/repositories/site-settings.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("auth discovery identity", () => {
	let db: Kysely<Database>;
	beforeEach(async () => {
		db = await setupTestDatabase();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("never exposes a shared legacy site title as another site's name", async () => {
		await new OptionsRepository(db).set("emdash:site_title", "Legacy title");
		for (const [siteId, title] of [
			["foo", "Foo title"],
			["bar", "Bar title"],
		] as const) {
			await runWithContext({ editMode: false, siteId }, () =>
				new SiteSettingsRepository(db).set("title", title),
			);
		}
		const getName = async (siteId?: string) => {
			const run = async () => {
				const response = await GET({ locals: { emdash: { db } } } as Parameters<typeof GET>[0]);
				const body: unknown = await response.json();
				if (!body || typeof body !== "object" || !("instance" in body))
					throw new Error("No instance");
				return body.instance;
			};
			return siteId ? runWithContext({ editMode: false, siteId }, run) : run();
		};
		expect(await getName("foo")).toMatchObject({ name: "Foo title" });
		expect(await getName("bar")).toMatchObject({ name: "Bar title" });
		expect(await getName()).toMatchObject({ name: "EmDash" });
	});
});
