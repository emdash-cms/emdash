import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	MediaUsageWorkRepository,
	type MediaUsageWorkState,
} from "../../../src/database/repositories/media-usage-work.js";
import { InvalidCursorError } from "../../../src/database/repositories/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("media usage work operator repository", (dialect) => {
	let ctx: DialectTestContext;
	let collectionId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		const collection = await ctx.db
			.selectFrom("_emdash_collections")
			.select(["id", "slug"])
			.where("slug", "=", "post")
			.executeTakeFirstOrThrow();
		collectionId = collection.id;
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				collection_id: collectionId,
				capture_state: "active",
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				reconciliation_required: 0,
			})
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "post")
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("returns deterministic bounded cursor pages without exposing internal ownership", async () => {
		for (let index = 0; index < 27; index++) {
			await insertWork({
				contentId: `entry-${String(index).padStart(3, "0")}`,
				state: STATES[index % STATES.length]!,
				updatedAt: `2026-08-06T12:${String(Math.floor(index / 3)).padStart(2, "0")}:00.000Z`,
			});
		}

		const repo = new MediaUsageWorkRepository(ctx.db);
		const first = await repo.findOperatorPage({ collectionSlug: "post", limit: 10 });
		expect(first?.items).toHaveLength(10);
		expect(first?.nextCursor).toEqual(expect.any(String));
		expect(first?.items[0]).toEqual(
			expect.objectContaining({
				collectionId,
				collectionSlug: "post",
				contentId: "entry-026",
			}),
		);
		for (const item of first!.items) {
			expect(item).not.toHaveProperty("leaseToken");
			expect(item).not.toHaveProperty("workVersion");
			expect(item).not.toHaveProperty("changeEpoch");
		}

		const second = await repo.findOperatorPage({
			collectionSlug: "post",
			limit: 10,
			cursor: first!.nextCursor,
		});
		expect(second?.items).toHaveLength(10);
		expect(new Set([...first!.items, ...second!.items].map((item) => item.contentId)).size).toBe(
			20,
		);
	});

	it("distinguishes an exact full page from a page with more work", async () => {
		for (let index = 0; index < 100; index++) {
			await insertWork({
				contentId: `entry-boundary-${String(index).padStart(3, "0")}`,
				state: "pending",
				updatedAt: `2026-08-06T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
			});
		}

		const repo = new MediaUsageWorkRepository(ctx.db);
		const exact = await repo.findOperatorPage({ collectionSlug: "post", limit: 100 });
		expect(exact?.items).toHaveLength(100);
		expect(exact?.nextCursor).toBeUndefined();

		await insertWork({
			contentId: "entry-boundary-100",
			state: "pending",
			updatedAt: "2026-08-06T12:02:00.000Z",
		});
		const first = await repo.findOperatorPage({ collectionSlug: "post", limit: 100 });
		expect(first?.items).toHaveLength(100);
		expect(first?.nextCursor).toEqual(expect.any(String));
		const second = await repo.findOperatorPage({
			collectionSlug: "post",
			limit: 100,
			cursor: first?.nextCursor,
		});
		expect(second?.items).toHaveLength(1);
		expect(second?.nextCursor).toBeUndefined();
	});

	it("rejects malformed cursors instead of silently restarting pagination", async () => {
		await expect(
			new MediaUsageWorkRepository(ctx.db).findOperatorPage({
				collectionSlug: "post",
				cursor: "not-a-cursor",
			}),
		).rejects.toBeInstanceOf(InvalidCursorError);
	});

	it("filters one state without crossing collection identity", async () => {
		await insertWork({ contentId: "failed-current", state: "failed" });
		await insertWork({ contentId: "pending-current", state: "pending" });
		await ctx.db
			.insertInto("_emdash_media_usage_work")
			.values(workRow("other-collection", "post", "failed-old", "failed"))
			.execute();

		const page = await new MediaUsageWorkRepository(ctx.db).findOperatorPage({
			collectionSlug: "post",
			state: "failed",
			limit: 50,
		});

		expect(page?.items.map((item) => item.contentId)).toEqual(["failed-current"]);
		expect(page?.nextCursor).toBeUndefined();
	});

	it("returns null for a missing current collection", async () => {
		const page = await new MediaUsageWorkRepository(ctx.db).findOperatorPage({
			collectionSlug: "missing",
		});

		expect(page).toBeNull();
	});

	it("leaves pending work and its coverage epoch unchanged", async () => {
		await insertWork({ contentId: "entry-pending", state: "pending", workVersion: 4 });
		const beforeStatus = await statusRow();

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-pending",
		});

		expect(result).toEqual(
			expect.objectContaining({
				outcome: "pending",
				changed: false,
				work: expect.objectContaining({ contentId: "entry-pending", state: "pending" }),
			}),
		);
		expect(await statusRow()).toEqual(beforeStatus);
		expect(await rawWork("entry-pending")).toEqual(
			expect.objectContaining({ work_version: expect.toSatisfy((value) => Number(value) === 4) }),
		);
	});

	it.each(["retry", "failed"] as const)(
		"reopens %s work and invalidates complete coverage",
		async (state) => {
			await insertWork({
				contentId: `entry-${state}`,
				state,
				workVersion: 7,
				attemptCount: 3,
				lastErrorCode: "MEDIA_USAGE_PROCESSING_FAILED",
			});

			const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
				collectionId,
				contentId: `entry-${state}`,
			});

			expect(result).toEqual(
				expect.objectContaining({
					outcome: "pending",
					changed: true,
					work: expect.objectContaining({
						state: "pending",
						attemptCount: 0,
						lastErrorCode: null,
					}),
				}),
			);
			expect(await rawWork(`entry-${state}`)).toEqual(
				expect.objectContaining({
					work_version: expect.toSatisfy((value) => Number(value) === 8),
					lease_token: null,
					lease_expires_at: null,
					last_attempted_at: null,
				}),
			);
			expect(await statusRow()).toEqual(
				expect.objectContaining({
					status: "stale",
					completed_at: null,
					change_epoch: expect.toSatisfy((value) => Number(value) === 1),
				}),
			);
		},
	);

	it("takes over an expired lease without retaining its owner", async () => {
		await insertWork({
			contentId: "entry-expired",
			state: "leased",
			workVersion: 2,
			leaseToken: "expired-owner",
			leaseExpiresAt: "2000-01-01T00:00:00.000Z",
		});

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-expired",
		});

		expect(result).toEqual(expect.objectContaining({ outcome: "pending", changed: true }));
		expect(await rawWork("entry-expired")).toEqual(
			expect.objectContaining({ state: "pending", lease_token: null, lease_expires_at: null }),
		);
	});

	it("does not steal a live lease or expose its token", async () => {
		await insertWork({
			contentId: "entry-live",
			state: "leased",
			workVersion: 3,
			leaseToken: "private-owner-token",
			leaseExpiresAt: "2100-01-01T00:00:00.000Z",
		});

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-live",
		});

		expect(result).toEqual({
			outcome: "lease_active",
			leaseExpiresAt: "2100-01-01T00:00:00.000Z",
		});
		expect(JSON.stringify(result)).not.toContain("private-owner-token");
		expect(await rawWork("entry-live")).toEqual(
			expect.objectContaining({
				state: "leased",
				work_version: expect.toSatisfy((value) => Number(value) === 3),
				lease_token: "private-owner-token",
			}),
		);
	});

	it("creates missing work for a current active collection without requiring the content row", async () => {
		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "already-deleted-entry",
		});

		expect(result).toEqual(
			expect.objectContaining({
				outcome: "pending",
				changed: true,
				work: expect.objectContaining({
					collectionId,
					collectionSlug: "post",
					contentId: "already-deleted-entry",
					state: "pending",
				}),
			}),
		);
		expect(await statusRow()).toEqual(
			expect.objectContaining({ status: "stale", completed_at: null }),
		);
	});

	it("does not overwrite newer pending work created during a retry", async () => {
		if (dialect !== "sqlite") return;
		await insertWork({
			contentId: "entry-newer-work",
			state: "failed",
			workVersion: 7,
			attemptCount: 5,
			lastErrorCode: "MEDIA_USAGE_PROCESSING_FAILED",
		});
		await sql`
			CREATE TRIGGER retry_newer_work_wins
			AFTER UPDATE OF change_epoch ON _emdash_media_usage_index_status
			BEGIN
				UPDATE _emdash_media_usage_work
				SET state = 'pending',
					work_version = work_version + 1,
					attempt_count = 0,
					last_error_code = NULL
				WHERE collection_id = NEW.collection_id
					AND content_id = 'entry-newer-work';
			END
		`.execute(ctx.db);

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-newer-work",
		});

		expect(result).toEqual(
			expect.objectContaining({
				outcome: "pending",
				changed: false,
				work: expect.objectContaining({ state: "pending", attemptCount: 0 }),
			}),
		);
		expect(await rawWork("entry-newer-work")).toEqual(
			expect.objectContaining({
				work_version: expect.toSatisfy((value) => Number(value) === 8),
				state: "pending",
			}),
		);
	});

	it("keeps coverage conservative when another owner removes work during retry", async () => {
		if (dialect !== "sqlite") return;
		await insertWork({ contentId: "entry-removed-race", state: "failed", workVersion: 4 });
		await sql`
			CREATE TRIGGER retry_remove_work_race
			AFTER UPDATE OF change_epoch ON _emdash_media_usage_index_status
			BEGIN
				DELETE FROM _emdash_media_usage_work
				WHERE collection_id = NEW.collection_id
					AND content_id = 'entry-removed-race';
			END
		`.execute(ctx.db);

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-removed-race",
		});

		expect(result).toEqual({ outcome: "conflict" });
		expect(await statusRow()).toEqual(
			expect.objectContaining({ status: "stale", completed_at: null }),
		);
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select("content_id")
				.where("content_id", "=", "entry-removed-race")
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("does not reopen obsolete work after its collection is removed", async () => {
		if (dialect !== "sqlite") return;
		await insertWork({ contentId: "entry-obsolete", state: "failed", workVersion: 2 });
		await removeCollectionAfterCoverageInvalidation();

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-obsolete",
		});

		expect(result).toEqual({ outcome: "collection_not_found" });
		expect(await rawWork("entry-obsolete")).toEqual(
			expect.objectContaining({
				state: "failed",
				work_version: expect.toSatisfy((value) => Number(value) === 2),
			}),
		);
	});

	it("does not create work after its collection is removed", async () => {
		if (dialect !== "sqlite") return;
		await removeCollectionAfterCoverageInvalidation();

		const result = await new MediaUsageWorkRepository(ctx.db).retryOperatorWork({
			collectionId,
			contentId: "entry-missing-race",
		});

		expect(result).toEqual({ outcome: "collection_not_found" });
		expect(
			await ctx.db
				.selectFrom("_emdash_media_usage_work")
				.select("content_id")
				.where("content_id", "=", "entry-missing-race")
				.executeTakeFirst(),
		).toBeUndefined();
	});

	it("rejects missing and inactive collection identities without creating work", async () => {
		const repo = new MediaUsageWorkRepository(ctx.db);
		expect(
			await repo.retryOperatorWork({ collectionId: "missing-collection", contentId: "entry-1" }),
		).toEqual({ outcome: "collection_not_found" });

		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "installing" })
			.where("collection_id", "=", collectionId)
			.execute();
		expect(await repo.retryOperatorWork({ collectionId, contentId: "entry-1" })).toEqual({
			outcome: "collection_not_found",
		});
		expect(
			await ctx.db.selectFrom("_emdash_media_usage_work").select("content_id").execute(),
		).toEqual([]);
	});

	async function insertWork(input: {
		contentId: string;
		state: MediaUsageWorkState;
		updatedAt?: string;
		workVersion?: number;
		attemptCount?: number;
		lastErrorCode?: string | null;
		leaseToken?: string | null;
		leaseExpiresAt?: string | null;
	}): Promise<void> {
		await ctx.db
			.insertInto("_emdash_media_usage_work")
			.values({
				...workRow(collectionId, "post", input.contentId, input.state),
				work_version: input.workVersion ?? 1,
				attempt_count: input.attemptCount ?? 0,
				last_error_code: input.lastErrorCode ?? null,
				lease_token: input.leaseToken ?? null,
				lease_expires_at: input.leaseExpiresAt ?? null,
				updated_at: input.updatedAt ?? "2026-08-06T12:00:00.000Z",
			})
			.execute();
	}

	function workRow(
		rowCollectionId: string,
		collectionSlug: string,
		contentId: string,
		state: MediaUsageWorkState,
	) {
		return {
			collection_id: rowCollectionId,
			collection_slug: collectionSlug,
			content_id: contentId,
			change_epoch: 0,
			work_version: 1,
			state,
			attempt_count: 0,
			next_attempt_at: "2000-01-01T00:00:00.000Z",
			lease_token: null,
			lease_expires_at: null,
			last_attempted_at: null,
			last_error_code: null,
			created_at: "2026-08-06T12:00:00.000Z",
			updated_at: "2026-08-06T12:00:00.000Z",
		};
	}

	function rawWork(contentId: string) {
		return ctx.db
			.selectFrom("_emdash_media_usage_work")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.where("content_id", "=", contentId)
			.executeTakeFirstOrThrow();
	}

	function statusRow() {
		return ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.selectAll()
			.where("collection_id", "=", collectionId)
			.executeTakeFirstOrThrow();
	}

	async function removeCollectionAfterCoverageInvalidation(): Promise<void> {
		await sql`
			CREATE TRIGGER retry_collection_removed
			AFTER UPDATE OF change_epoch ON _emdash_media_usage_index_status
			BEGIN
				DELETE FROM _emdash_collections WHERE id = NEW.collection_id;
			END
		`.execute(ctx.db);
	}
});

const STATES = ["pending", "retry", "leased", "failed"] as const;
