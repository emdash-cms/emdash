import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { DashboardStats } from "../../../src/api/handlers/dashboard.js";
import { GET } from "../../../src/astro/routes/api/dashboard.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("GET /_emdash/api/dashboard count visibility", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const users = new UserRepository(ctx.db);
		await users.create({ email: "admin@example.com", role: Role.ADMIN });
		await users.create({ email: "editor@example.com", role: Role.EDITOR });
		await new MediaRepository(ctx.db).create({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			storageKey: "photo.jpg",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function getDashboard(role: RoleLevel): Promise<DashboardStats> {
		const response = await GET({
			locals: { emdash: { db: ctx.db }, user: { id: "user-1", role } },
			url: new URL("http://localhost/_emdash/api/dashboard"),
		} as unknown as APIContext);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: DashboardStats };
		return body.data;
	}

	it.each([
		["a subscriber", Role.SUBSCRIBER],
		["an editor", Role.EDITOR],
	])("hides the user count from %s, who cannot list users", async (_name, role) => {
		const stats = await getDashboard(role);

		expect(stats).not.toHaveProperty("userCount");
		expect(stats.mediaCount).toBe(1);
	});

	it("shows an admin the user and media counts", async () => {
		const stats = await getDashboard(Role.ADMIN);

		expect(stats.userCount).toBe(2);
		expect(stats.mediaCount).toBe(1);
	});
});
