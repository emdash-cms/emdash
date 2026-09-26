import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/database/transaction.js", () => ({
	withTransaction: async <T>(db: unknown, fn: (db: unknown) => Promise<T>) => fn(db),
}));

import { handleScheduledPolicyRejection } from "../../../src/api/handlers/content.js";
import { encodeRev } from "../../../src/api/rev.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { scheduledPolicyRejectionKey } from "../../../src/plugins/content-policy.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("scheduled policy rejection without transaction support", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabaseWithCollections>>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("keeps content scheduled when persisting the rejection fails", async () => {
		const repo = new ContentRepository(db);
		const scheduledAt = "2030-01-01T00:00:00.000Z";
		const created = await repo.create({
			type: "post",
			slug: "rejection-write-failure",
			status: "draft",
			data: { title: "Scheduled" },
		});
		const item = await repo.update("post", created.id, { status: "scheduled", scheduledAt });
		await sql`
			CREATE TRIGGER reject_scheduled_policy_option
			BEFORE INSERT ON options
			WHEN NEW.name LIKE 'emdash:scheduled-policy-rejection:%'
			BEGIN
				SELECT RAISE(FAIL, 'rejection write failed');
			END
		`.execute(db);

		const result = await handleScheduledPolicyRejection(db, "post", item.id, {
			_rev: encodeRev(item),
			rejection: {
				collection: "post",
				id: item.id,
				pluginId: "approval-policy",
				reason: "Approval is required",
				rejectedAt: "2029-12-31T23:59:59.000Z",
			},
		});

		expect(result).toMatchObject({ success: false, error: { code: "CONTENT_UNSCHEDULE_ERROR" } });
		expect(await repo.findById("post", item.id)).toMatchObject({
			status: "scheduled",
			scheduledAt,
		});
		expect(
			await db
				.selectFrom("options")
				.select("name")
				.where("name", "=", scheduledPolicyRejectionKey("post", item.id))
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("keeps an actionable rejection when unscheduling fails", async () => {
		const repo = new ContentRepository(db);
		const scheduledAt = "2030-01-01T00:00:00.000Z";
		const created = await repo.create({
			type: "post",
			slug: "unschedule-write-failure",
			status: "draft",
			data: { title: "Scheduled" },
		});
		const item = await repo.update("post", created.id, { status: "scheduled", scheduledAt });
		await sql`
			CREATE TRIGGER reject_policy_unschedule
			BEFORE UPDATE OF scheduled_at ON ec_post
			WHEN NEW.scheduled_at IS NULL
			BEGIN
				SELECT RAISE(FAIL, 'unschedule failed');
			END
		`.execute(db);
		const rejection = {
			collection: "post",
			id: item.id,
			pluginId: "approval-policy",
			reason: "Approval is required",
			rejectedAt: "2029-12-31T23:59:59.000Z",
		};

		const result = await handleScheduledPolicyRejection(db, "post", item.id, {
			_rev: encodeRev(item),
			rejection,
		});

		expect(result).toMatchObject({ success: false, error: { code: "CONTENT_UNSCHEDULE_ERROR" } });
		expect(await repo.findById("post", item.id)).toMatchObject({
			status: "scheduled",
			scheduledAt,
		});
		expect(
			await new OptionsRepository(db).get(scheduledPolicyRejectionKey("post", item.id)),
		).toEqual(rejection);
	});

	it("removes its stale rejection when the content revision conflicts", async () => {
		const repo = new ContentRepository(db);
		const created = await repo.create({
			type: "post",
			slug: "stale-rejection",
			status: "draft",
			data: { title: "Scheduled" },
		});
		const stale = await repo.update("post", created.id, {
			status: "scheduled",
			scheduledAt: "2030-01-01T00:00:00.000Z",
		});
		const current = await repo.update("post", created.id, {
			scheduledAt: "2030-01-02T00:00:00.000Z",
		});

		const result = await handleScheduledPolicyRejection(db, "post", created.id, {
			_rev: encodeRev(stale),
			rejection: {
				collection: "post",
				id: created.id,
				pluginId: "approval-policy",
				reason: "Approval is required",
				rejectedAt: "2029-12-31T23:59:59.000Z",
			},
		});

		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await repo.findById("post", created.id)).toMatchObject({
			scheduledAt: current.scheduledAt,
		});
		expect(
			await new OptionsRepository(db).get(scheduledPolicyRejectionKey("post", created.id)),
		).toBeNull();
	});
});
