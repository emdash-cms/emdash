import { afterEach, beforeEach, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { createKVAccess } from "../../../src/plugins/context.js";
import { createSettingsAccess } from "../../../src/plugins/settings.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("plugin KV prefix listings", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("matches prefixes case-sensitively and reads settings only through their accessor", async () => {
		const options = new OptionsRepository(ctx.db);
		await options.set("plugin:seo:settings:apiKey", "private-token");
		await options.set("plugin:seo:Stats", "upper");
		await options.set("plugin:seo:stats", "lower");
		const observed: string[] = [];
		const settings = createSettingsAccess(
			options,
			"seo",
			{ apiKey: { type: "secret", label: "API key" } },
			undefined,
			(_key, value) => observed.push(value),
		);
		const kv = createKVAccess(options, "seo", settings);

		expect(await kv.list("S")).toEqual([{ key: "Stats", value: "upper" }]);
		expect(observed).toEqual([]);
		expect(await kv.list("Settings:")).toEqual([]);
		expect(await kv.list("s")).toEqual([
			{ key: "stats", value: "lower" },
			{ key: "settings:apiKey", value: "private-token" },
		]);
		expect(observed).toEqual(["private-token"]);
		expect(await kv.list("settings:A")).toEqual([]);
	});
});
