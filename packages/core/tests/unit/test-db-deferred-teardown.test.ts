import { sql } from "kysely";
import { expect, it } from "vitest";

import { after } from "../../src/after.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

it("drains deferred database work before test database teardown", async () => {
	const db = await setupTestDatabase();
	let release!: () => void;
	after(async () => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await sql`select 1`.execute(db);
	});
	await Promise.resolve();

	let tornDown = false;
	const teardown = teardownTestDatabase(db).then(() => {
		tornDown = true;
		return null;
	});
	await Promise.resolve();
	expect(tornDown).toBe(false);

	release();
	await teardown;
	expect(tornDown).toBe(true);
});
