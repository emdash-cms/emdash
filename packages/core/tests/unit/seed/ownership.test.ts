import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	AUTO_SEED_COMPLETE_OPTION,
	claimExplicitSeedOwnership,
} from "../../../src/seed/ownership.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("explicit seed ownership", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("claims collection seeds before they are applied", async () => {
		const seed: SeedFile = {
			version: "1",
			collections: [{ slug: "posts", label: "Posts", fields: [] }],
		};

		await claimExplicitSeedOwnership(db, seed);

		await expect(
			db
				.selectFrom("options")
				.select("value")
				.where("name", "=", AUTO_SEED_COMPLETE_OPTION)
				.executeTakeFirst(),
		).resolves.toEqual({ value: "true" });
	});

	it("keeps a settings-only seed eligible for the default schema", async () => {
		await claimExplicitSeedOwnership(db, { version: "1", settings: { title: "Example" } });

		await expect(
			db
				.selectFrom("options")
				.select("value")
				.where("name", "=", AUTO_SEED_COMPLETE_OPTION)
				.executeTakeFirst(),
		).resolves.toBeUndefined();
	});
});
