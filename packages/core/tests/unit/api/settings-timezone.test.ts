import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleSettingsUpdate } from "../../../src/api/handlers/settings.js";
import type { Database } from "../../../src/database/types.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("handleSettingsUpdate timezone", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("saves a valid IANA timezone", async () => {
		const result = await handleSettingsUpdate(db, null, { timezone: "Europe/Lisbon" });

		expect(result.success).toBe(true);
		expect((await getSiteSettingsWithDb(db, null)).timezone).toBe("Europe/Lisbon");
	});

	it("rejects a timezone the runtime does not recognize", async () => {
		const result = await handleSettingsUpdate(db, null, { timezone: "Lisboa" });

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(result.error.message).toContain("Lisboa");
		expect((await getSiteSettingsWithDb(db, null)).timezone).toBeUndefined();
	});

	it("still saves other settings when an already stored timezone is sent back unchanged", async () => {
		await setSiteSettings({ timezone: "Lisboa" }, db);

		const result = await handleSettingsUpdate(db, null, { timezone: "Lisboa", title: "Renamed" });

		expect(result.success).toBe(true);
		expect((await getSiteSettingsWithDb(db, null)).title).toBe("Renamed");
	});
});
