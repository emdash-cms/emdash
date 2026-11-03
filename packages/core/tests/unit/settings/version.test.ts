import { afterEach, beforeEach, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import {
	normalizeSiteSettingsVersion,
	siteSettingsVersionQuery,
} from "../../../src/settings/version.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("site settings version", (dialect) => {
	let ctx: DialectTestContext | undefined;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		ctx = undefined;
	});

	async function readVersion(): Promise<string> {
		if (!ctx) throw new Error("test database is not initialized");
		const row = await ctx.db
			.selectNoFrom(siteSettingsVersionQuery(ctx.db).as("version"))
			.executeTakeFirstOrThrow();
		return normalizeSiteSettingsVersion(row.version);
	}

	it("changes for site setting insert, update, and deletion but not unrelated writes", async () => {
		if (!ctx) throw new Error("test database is not initialized");
		const options = new OptionsRepository(ctx.db);

		const empty = await readVersion();
		expect(empty).toBe("[]");

		await options.set("site:title", "First");
		const inserted = await readVersion();
		expect(inserted).not.toBe(empty);

		await options.set("site:title", "Second");
		const updated = await readVersion();
		expect(updated).not.toBe(inserted);

		await options.set("unrelated", "value");
		expect(await readVersion()).toBe(updated);

		await options.delete("site:title");
		expect(await readVersion()).not.toBe(updated);
		expect(await readVersion()).toBe(empty);
	});
});
