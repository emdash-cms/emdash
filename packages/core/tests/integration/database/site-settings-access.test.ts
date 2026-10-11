import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up } from "../../../src/database/migrations/097_site_settings.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { SiteSettingsRepository } from "../../../src/database/repositories/site-settings.js";
import { runWithContext } from "../../../src/request-context.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../../src/settings/index.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("site settings access", (dialect) => {
	let ctx: DialectTestContext;
	let settings: SiteSettingsRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await up(ctx.db);
		settings = new SiteSettingsRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	const asSite = <T>(siteId: string, fn: () => T): T =>
		runWithContext({ editMode: false, siteId }, fn);

	it("isolates reads, updates, listing, and deletion by the selected site", async () => {
		await asSite("foo", () => settings.set("title", "Foo"));
		await asSite("bar", () => settings.set("title", "Bar"));
		await asSite("foo", () => settings.set("title", "Foo updated"));
		await asSite("foo", () => settings.set("seo", { description: "Foo only" }));

		expect(await asSite("foo", () => settings.get<string>("title"))).toBe("Foo updated");
		expect(await asSite("bar", () => settings.get<string>("title"))).toBe("Bar");
		expect(await asSite("bar", () => settings.getAll())).toEqual(new Map([["title", "Bar"]]));
		await asSite("foo", () => settings.delete("title"));
		expect(await asSite("foo", () => settings.get("title"))).toBeUndefined();
		expect(await asSite("bar", () => settings.get("title"))).toBe("Bar");
	});

	it("renders each site's public settings with the same keys", async () => {
		await asSite("foo", () => setSiteSettings({ title: "Foo title", tagline: "Foo only" }, ctx.db));
		await asSite("bar", () => setSiteSettings({ title: "Bar title" }, ctx.db));
		expect((await asSite("foo", () => getSiteSettingsWithDb(ctx.db))).title).toBe("Foo title");
		expect(await asSite("bar", () => getSiteSettingsWithDb(ctx.db))).toEqual({
			title: "Bar title",
		});
		await expect(getSiteSettingsWithDb(ctx.db)).rejects.toThrow("server-selected site");
		await expect(setSiteSettings({ title: "No site" }, ctx.db)).rejects.toThrow(
			"server-selected site",
		);
	});

	it("denies all site-owned operations without server context", async () => {
		await asSite("foo", () => settings.set("title", "Foo"));
		await expect(settings.get("title")).rejects.toThrow("server-selected site");
		await expect(settings.getAll()).rejects.toThrow("server-selected site");
		await expect(settings.set("title", "Intruder")).rejects.toThrow("server-selected site");
		await expect(settings.delete("title")).rejects.toThrow("server-selected site");
		expect(await asSite("foo", () => settings.get("title"))).toBe("Foo");
	});

	it("keeps shared options writable but rejects legacy site settings after migration", async () => {
		const shared = new OptionsRepository(ctx.db);
		await expect(shared.set("site:title", "Old path")).rejects.toThrow();
		await shared.set("plugin:shared", "Shared value");
		expect(await shared.get("plugin:shared")).toBe("Shared value");
	});

	it("does not use client-like keys to select another site or touch shared options", async () => {
		await asSite("foo", () => settings.set("title", "Foo"));
		await expect(asSite("bar", () => settings.set("foo:site:title", "Spoof"))).rejects.toThrow(
			"Invalid site setting key",
		);
		await expect(asSite("bar", () => settings.get("plugin:shared"))).rejects.toThrow(
			"Invalid site setting key",
		);
		await sql`INSERT INTO options (name, value) VALUES ('plugin:shared', '"Shared"')`.execute(
			ctx.db,
		);
		expect(await asSite("bar", () => settings.getAll())).toEqual(new Map());
		const shared = await sql<{
			value: string;
		}>`SELECT value FROM options WHERE name = 'plugin:shared'`.execute(ctx.db);
		expect(shared.rows[0]?.value).toBe('"Shared"');
	});
});
