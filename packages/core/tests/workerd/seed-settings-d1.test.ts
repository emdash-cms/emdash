import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import type { Database } from "../../src/database/types.js";
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
		.addColumn("value", "text", (col) => col.notNull())
		.addColumn("revision", "text")
		.execute();
});

afterAll(async () => {
	await db.destroy();
});

describe("applySeed site settings on D1", () => {
	it("skip mode creates missing settings and preserves existing ones", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Admin Title");

		const seed: SeedFile = {
			version: "1",
			settings: {
				title: "Seed Title",
				tagline: "A seeded tagline",
			},
		};

		const result = await applySeed(db, seed);

		expect(result.settings.applied).toBe(1);
		expect(await options.get("site:title")).toBe("Admin Title");
		expect(await options.get("site:tagline")).toBe("A seeded tagline");
	});

	it("keeps an inserted setting when a later key conflicts in skip mode", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Admin Title");

		const seed: SeedFile = {
			version: "1",
			settings: {
				tagline: "A seeded tagline",
				title: "Seed Title",
			},
		};

		const result = await applySeed(db, seed);

		expect(result.settings.applied).toBe(1);
		expect(await options.get("site:title")).toBe("Admin Title");
		expect(await options.get("site:tagline")).toBe("A seeded tagline");
	});

	it("preserves a concurrent admin write to site:title", async () => {
		const options = new OptionsRepository(db);

		const seed: SeedFile = {
			version: "1",
			settings: {
				title: "Seed Title",
				tagline: "A seeded tagline",
			},
		};

		const [, result] = await Promise.all([
			options.set("site:title", "Admin Title"),
			applySeed(db, seed),
		]);

		expect(result.settings.applied).toBe(1);
		expect(await options.get("site:title")).toBe("Admin Title");
		expect(await options.get("site:tagline")).toBe("A seeded tagline");
	});

	it("overwrites settings in update mode", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Admin Title");

		const seed: SeedFile = {
			version: "1",
			settings: {
				title: "Seed Title",
				tagline: "A seeded tagline",
			},
		};

		const result = await applySeed(db, seed, { onConflict: "update" });

		expect(result.settings.applied).toBe(2);
		expect(await options.get("site:title")).toBe("Seed Title");
		expect(await options.get("site:tagline")).toBe("A seeded tagline");
	});

	it("throws in error mode when a seeded setting already exists", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Admin Title");

		const seed: SeedFile = {
			version: "1",
			settings: {
				title: "Seed Title",
				tagline: "A seeded tagline",
			},
		};

		await expect(applySeed(db, seed, { onConflict: "error" })).rejects.toThrow(
			'Conflict: site setting "site:title" already exists',
		);
		expect(await options.get("site:tagline")).toBeNull();
	});

	it("does not roll back earlier settings when error mode finds a later conflict", async () => {
		const options = new OptionsRepository(db);
		await options.set("site:title", "Admin Title");

		const seed: SeedFile = {
			version: "1",
			settings: {
				tagline: "A seeded tagline",
				title: "Seed Title",
			},
		};

		await expect(applySeed(db, seed, { onConflict: "error" })).rejects.toThrow(
			'Conflict: site setting "site:title" already exists',
		);
		expect(await options.get("site:title")).toBe("Admin Title");
		expect(await options.get("site:tagline")).toBe("A seeded tagline");
	});
});
