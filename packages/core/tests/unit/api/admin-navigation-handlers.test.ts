/**
 * Admin navigation handler tests (real database).
 *
 * The read handler must treat unset, schema-invalid, and JSON-corrupt
 * stored values all as "no config" so the organizer can always recover by
 * saving fresh state; the write handler must persist the normal form, not
 * the raw input.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getAdminNavigation,
	setAdminNavigation,
} from "../../../src/api/handlers/admin-navigation.js";
import {
	ADMIN_NAVIGATION_OPTION_KEY,
	type AdminNavigationConfigV1,
} from "../../../src/api/schemas/admin-navigation.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("admin navigation handlers", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("reads null when no config is stored", async () => {
		const result = await getAdminNavigation(db);
		expect(result).toEqual({ success: true, data: { config: null } });
	});

	it("stores and returns the normalized config", async () => {
		const input: AdminNavigationConfigV1 = {
			version: 1,
			groups: [
				{ id: "editorial", label: "  Editorial  ", order: 0 },
				{ id: "editorial", label: "Duplicate", order: 9 },
			],
			items: [
				{ id: "collection:posts", groupId: "editorial", order: 0 },
				{ id: "collection:pages", hidden: false },
			],
		};

		const expected: AdminNavigationConfigV1 = {
			version: 1,
			groups: [{ id: "editorial", label: "Editorial", order: 0 }],
			items: [{ id: "collection:posts", groupId: "editorial", order: 0 }],
		};

		const saved = await setAdminNavigation(db, input);
		expect(saved).toEqual({ success: true, data: { config: expected } });

		// The normal form is what's persisted, not the raw input.
		const options = new OptionsRepository(db);
		expect(await options.get(ADMIN_NAVIGATION_OPTION_KEY)).toEqual(expected);

		const read = await getAdminNavigation(db);
		expect(read).toEqual({ success: true, data: { config: expected } });
	});

	it("rejects invalid config with VALIDATION_ERROR", async () => {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately invalid input
		const result = await setAdminNavigation(db, { version: 99 } as never);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("VALIDATION_ERROR");
		}
	});

	it("reads schema-invalid stored config as null", async () => {
		const options = new OptionsRepository(db);
		await options.set(ADMIN_NAVIGATION_OPTION_KEY, { version: 99, groups: [], items: [] });

		const result = await getAdminNavigation(db);
		expect(result).toEqual({ success: true, data: { config: null } });
	});

	it("reads a JSON-corrupt stored value as null instead of erroring", async () => {
		await db
			.insertInto("options")
			.values({ name: ADMIN_NAVIGATION_OPTION_KEY, value: "{not json" })
			.execute();

		const result = await getAdminNavigation(db);
		expect(result).toEqual({ success: true, data: { config: null } });
	});
});
