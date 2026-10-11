import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SiteSettingsRepository } from "../../../src/database/repositories/site-settings.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("site timezone fallback", () => {
	let db: Kysely<Database>;
	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("interprets a local schedule in Athens when unset, including summer time", async () => {
		await runWithContext({ editMode: false, siteId: "site-default" }, async () => {
			const repo = new ContentRepository(db);
			const winter = await repo.create(createPostFixture({ slug: "winter" }));
			const summer = await repo.create(createPostFixture({ slug: "summer" }));
			expect((await repo.schedule("post", winter.id, "2099-01-01T15:00")).scheduledAt).toBe(
				"2099-01-01T13:00:00.000Z",
			);
			expect((await repo.schedule("post", summer.id, "2099-07-01T15:00")).scheduledAt).toBe(
				"2099-07-01T12:00:00.000Z",
			);
		});
		await runWithContext({ editMode: false, siteId: "site-default" }, async () => {
			await new SiteSettingsRepository(db).set("timezone", "UTC");
			const repo = new ContentRepository(db);
			const explicit = await repo.create(createPostFixture({ slug: "explicit" }));
			expect((await repo.schedule("post", explicit.id, "2099-07-01T15:00")).scheduledAt).toBe(
				"2099-07-01T15:00:00.000Z",
			);
		});
	});
});
