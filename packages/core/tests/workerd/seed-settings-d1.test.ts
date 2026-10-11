import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it as test } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { SiteSettingsRepository } from "../../src/database/repositories/site-settings.js";
import type { Database } from "../../src/database/types.js";
import { runWithContext } from "../../src/request-context.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await db.schema
		.createTable("options")
		.addColumn("name", "text", (col) => col.primaryKey())
		.addColumn("site_id", "text")
		.addColumn("value", "text", (col) => col.notNull())
		.addColumn("revision", "text")
		.execute();
});

afterAll(async () => {
	await db.destroy();
});

const it = (name: string, fn: () => Promise<void>) =>
	test(name, () => runWithContext({ editMode: false, siteId: "site-default" }, fn));

const seed = (settings: NonNullable<SeedFile["settings"]>): SeedFile => ({
	version: "1",
	settings,
});

describe("applySeed site settings on D1", () => {
	it("skip mode creates missing settings and preserves existing ones", async () => {
		const options = new SiteSettingsRepository(db);
		await options.set("title", "Admin Title");
		const result = await applySeed(db, seed({ title: "Seed Title", tagline: "A seeded tagline" }));
		expect(result.settings.applied).toBe(1);
		expect(await options.get("title")).toBe("Admin Title");
		expect(await options.get("tagline")).toBe("A seeded tagline");
	});

	it("keeps an inserted setting when a later key conflicts in skip mode", async () => {
		const options = new SiteSettingsRepository(db);
		await options.set("title", "Admin Title");
		const result = await applySeed(db, seed({ tagline: "A seeded tagline", title: "Seed Title" }));
		expect(result.settings.applied).toBe(1);
		expect(await options.get("title")).toBe("Admin Title");
		expect(await options.get("tagline")).toBe("A seeded tagline");
	});

	it("preserves a concurrent admin write to the same site's title", async () => {
		const options = new SiteSettingsRepository(db);
		const [, result] = await Promise.all([
			options.set("title", "Admin Title"),
			applySeed(db, seed({ title: "Seed Title", tagline: "A seeded tagline" })),
		]);
		expect(result.settings.applied).toBe(1);
		expect(await options.get("title")).toBe("Admin Title");
		expect(await options.get("tagline")).toBe("A seeded tagline");
	});

	it("overwrites settings in update mode", async () => {
		const options = new SiteSettingsRepository(db);
		await options.set("title", "Admin Title");
		const result = await applySeed(db, seed({ title: "Seed Title", tagline: "A seeded tagline" }), {
			onConflict: "update",
		});
		expect(result.settings.applied).toBe(2);
		expect(await options.get("title")).toBe("Seed Title");
		expect(await options.get("tagline")).toBe("A seeded tagline");
	});

	it("throws in error mode when a seeded setting already exists", async () => {
		const options = new SiteSettingsRepository(db);
		await options.set("title", "Admin Title");
		await expect(
			applySeed(db, seed({ title: "Seed Title", tagline: "A seeded tagline" }), {
				onConflict: "error",
			}),
		).rejects.toThrow('Conflict: site setting "site:title" already exists');
		expect(await options.get("tagline")).toBeUndefined();
	});

	it("does not roll back earlier settings when error mode finds a later conflict", async () => {
		const options = new SiteSettingsRepository(db);
		await options.set("title", "Admin Title");
		await expect(
			applySeed(db, seed({ tagline: "A seeded tagline", title: "Seed Title" }), {
				onConflict: "error",
			}),
		).rejects.toThrow('Conflict: site setting "site:title" already exists');
		expect(await options.get("title")).toBe("Admin Title");
		expect(await options.get("tagline")).toBe("A seeded tagline");
	});
});
