import { afterEach, beforeEach, expect, it } from "vitest";

import { UserRepository } from "../../../src/database/repositories/user.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("UserRepository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: UserRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new UserRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("advances updated_at for non-empty updates and preserves it for empty updates", async () => {
		const user = await repo.create({
			email: "timestamp@example.com",
			name: "Original",
			role: "admin",
		});
		const staleTimestamp = "2000-01-01T00:00:00.000Z";

		await ctx.db
			.updateTable("users")
			.set({ updated_at: staleTimestamp })
			.where("id", "=", user.id)
			.execute();

		await repo.update(user.id, {});

		let row = await ctx.db
			.selectFrom("users")
			.select(["name", "updated_at"])
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(row.updated_at).toBe(staleTimestamp);

		await repo.update(user.id, { name: "Original" });

		row = await ctx.db
			.selectFrom("users")
			.select(["name", "updated_at"])
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(row.name).toBe("Original");
		expect(Date.parse(row.updated_at)).toBeGreaterThan(Date.parse(staleTimestamp));
		if (dialect === "sqlite") {
			expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		}
	});
});
