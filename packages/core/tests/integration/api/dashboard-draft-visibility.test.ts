import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DashboardStats } from "../../../src/api/handlers/dashboard.js";
import { GET } from "../../../src/astro/routes/api/dashboard.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { scheduledPolicyRejectionKey } from "../../../src/plugins/content-policy.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("GET /_emdash/api/dashboard draft visibility", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const content = new ContentRepository(db);

		await content.create(
			createPostFixture({
				slug: "live-post",
				status: "published",
				data: { title: "Live post", content: [] },
			}),
		);
		await content.create(
			createPostFixture({ slug: "secret-draft", data: { title: "Secret draft", content: [] } }),
		);
		const scheduled = await content.create(
			createPostFixture({
				slug: "embargoed-launch",
				data: { title: "Embargoed launch", content: [] },
			}),
		);
		await content.schedule("post", scheduled.id, new Date(Date.now() + 86_400_000).toISOString());
		await new OptionsRepository(db).set(scheduledPolicyRejectionKey("post", scheduled.id), {
			collection: "post",
			id: scheduled.id,
			pluginId: "content-guard",
			reason: "Approval is required.",
			rejectedAt: "2030-01-01T00:00:00.000Z",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function getDashboard(role: RoleLevel): Promise<DashboardStats> {
		const response = await GET({
			locals: { emdash: { db }, user: { id: "user-1", role } },
			url: new URL("http://localhost/_emdash/api/dashboard"),
		} as unknown as APIContext);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: DashboardStats };
		return body.data;
	}

	it("shows a subscriber only published entries", async () => {
		const stats = await getDashboard(Role.SUBSCRIBER);

		expect(stats.recentItems.map((item) => item.title)).toEqual(["Live post"]);
		expect(stats.collections.find((c) => c.slug === "post")).toMatchObject({
			total: 1,
			published: 1,
			draft: 0,
			scheduled: 0,
			overdueScheduled: 0,
		});
		expect(stats.policyRejectedScheduled).toBe(0);
		expect(stats.policyRejections).toEqual([]);
	});

	it("shows a contributor draft and scheduled entries", async () => {
		const stats = await getDashboard(Role.CONTRIBUTOR);

		expect(stats.recentItems.map((item) => item.title).toSorted()).toEqual([
			"Embargoed launch",
			"Live post",
			"Secret draft",
		]);
		expect(stats.collections.find((c) => c.slug === "post")).toMatchObject({
			total: 3,
			published: 1,
			draft: 1,
			scheduled: 1,
		});
		expect(stats.policyRejectedScheduled).toBe(1);
		expect(stats.policyRejections).toHaveLength(1);
	});
});
