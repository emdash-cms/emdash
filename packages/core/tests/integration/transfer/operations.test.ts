import { afterEach, beforeEach, expect, it } from "vitest";

import { TransferError } from "../../../src/transfer/errors.js";
import {
	toPublicOperation,
	TransferOperationRepository,
} from "../../../src/transfer/ops/operations.js";
import { TransferPackageIndexRepository } from "../../../src/transfer/ops/package-index.js";
import { TransferStagedFileRepository } from "../../../src/transfer/ops/staged-files.js";
import type { ExportCursor } from "../../../src/transfer/ops/states.js";
import { TRANSFER_RUNTIME_GENERATION } from "../../../src/transfer/ops/states.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof TransferError ? error.code : String(error);
	}
	return undefined;
}

describeEachDialect("transfer operations", (dialect) => {
	let ctx: DialectTestContext;
	let repo: TransferOperationRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new TransferOperationRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function expireLease(id: string): Promise<void> {
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
			.where("id", "=", id)
			.execute();
	}

	it("creates exports and imports in their initial states with a staging secret", async () => {
		const { operation: exported, created } = await repo.create({ kind: "export", createdBy: "u1" });
		expect(created).toBe(true);
		expect(exported.state).toBe("pending");
		expect(exported.stagingSecret).toMatch(/^[0-9a-f]{32}$/);
		expect(exported.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(exported.runtimeGeneration).toBe(TRANSFER_RUNTIME_GENERATION);

		const { operation: imported } = await repo.create({
			kind: "import",
			createdBy: "u1",
			packageDigest: DIGEST_A,
			originSiteId: "origin",
		});
		expect(imported.state).toBe("uploading");
		expect(imported.packageDigest).toBe(DIGEST_A);
		expect(imported.stagingSecret).not.toBe(exported.stagingSecret);
	});

	it("returns the same operation for a repeated idempotency key and rejects a different package", async () => {
		const first = await repo.create({
			kind: "import",
			createdBy: "u1",
			idempotencyKey: "k",
			packageDigest: DIGEST_A,
		});
		const again = await repo.create({
			kind: "import",
			createdBy: "u1",
			idempotencyKey: "k",
			packageDigest: DIGEST_A,
		});
		expect(again.created).toBe(false);
		expect(again.operation.id).toBe(first.operation.id);
		expect(
			await codeOf(
				repo.create({
					kind: "import",
					createdBy: "u1",
					idempotencyKey: "k",
					packageDigest: DIGEST_B,
				}),
			),
		).toBe("TRANSFER_IDEMPOTENCY_CONFLICT");
		const exportSameKey = await repo.create({
			kind: "export",
			createdBy: "u1",
			idempotencyKey: "k",
		});
		expect(exportSameKey.created).toBe(true);
	});

	it("allows only one import to occupy the target", async () => {
		const first = await repo.create({ kind: "import", createdBy: "u1" });
		expect(await codeOf(repo.create({ kind: "import", createdBy: "u2" }))).toBe(
			"TRANSFER_IMPORT_IN_PROGRESS",
		);
		expect((await repo.findOccupyingImport())?.id).toBe(first.operation.id);

		await repo.requestCancel(first.operation.id);
		const second = await repo.create({ kind: "import", createdBy: "u2" });
		expect(second.created).toBe(true);

		const claim = await repo.claim(second.operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.advance(second.operation.id, claim.leaseToken, {
			state: "running",
			markMutationStarted: true,
		});
		await repo.fail(second.operation.id, claim.leaseToken, { code: "TRANSFER_IMPORT_ERROR" });
		expect(await codeOf(repo.create({ kind: "import", createdBy: "u3" }))).toBe(
			"TRANSFER_IMPORT_IN_PROGRESS",
		);

		const abandoned = await repo.abandon(second.operation.id);
		expect(abandoned.state).toBe("abandoned");
		expect((await repo.create({ kind: "import", createdBy: "u3" })).created).toBe(true);
	});

	it("does not keep a failed import that never wrote in the occupying slot", async () => {
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		const claim = await repo.claim(operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.fail(operation.id, claim.leaseToken, {
			code: "TRANSFER_MANIFEST_INVALID",
			detail: { path: "x" },
		});
		const failed = await repo.require(operation.id);
		expect(failed.errorCode).toBe("TRANSFER_MANIFEST_INVALID");
		expect(failed.errorDetail).toEqual({ path: "x" });
		expect((await repo.create({ kind: "import", createdBy: "u1" })).created).toBe(true);
	});

	it("claims a lease once, fences writes on it, and lets another caller take over after expiry", async () => {
		const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
		const first = await repo.claim(operation.id, ["pending", "running"]);
		expect(first.outcome).toBe("claimed");
		if (first.outcome !== "claimed") return;
		expect(first.operation.attemptCount).toBe(1);

		const contender = await repo.claim(operation.id, ["pending", "running"]);
		expect(contender.outcome).toBe("lease_active");

		const cursor: ExportCursor = {
			stage: "export_records",
			attempt: 1,
			fence: { writeEpoch: 0, tables: [{ table: "media", count: 2, maxId: "01B" }] },
			kind: "entry",
			collection: "posts",
			after: { id: "01A" },
			nextSeq: 1,
		};
		const advanced = await repo.advance(operation.id, first.leaseToken, {
			state: "running",
			stage: "export_records",
			cursor,
			progress: { done: 1, total: 10 },
		});
		expect(advanced.cursor).toEqual(cursor);
		expect(advanced.progress).toEqual({ done: 1, total: 10 });

		await expireLease(operation.id);
		expect(await codeOf(repo.advance(operation.id, first.leaseToken, { stage: "x" }))).toBe(
			"TRANSFER_LEASE_LOST",
		);

		const second = await repo.claim(operation.id, ["running"]);
		expect(second.outcome).toBe("claimed");
		if (second.outcome !== "claimed") return;
		expect(await codeOf(repo.release(operation.id, first.leaseToken))).toBe("TRANSFER_LEASE_LOST");

		const released = await repo.release(operation.id, second.leaseToken, {
			progress: { done: 2, total: 10 },
		});
		expect(released.leaseToken).toBeNull();
		expect(released.attemptCount).toBe(2);

		const third = await repo.claim(operation.id, ["running"]);
		if (third.outcome !== "claimed") throw new Error("expected claim");
		const completed = await repo.complete(operation.id, third.leaseToken, { ttlSeconds: 60 });
		expect(completed.state).toBe("complete");
		expect(completed.completedAt).not.toBeNull();
		expect((await repo.claim(operation.id, ["running"])).outcome).toBe("invalid_state");
	});

	it("rejects cursors that do not match the typed cursor schema", async () => {
		const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
		const claim = await repo.claim(operation.id, ["pending"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await expect(
			repo.advance(operation.id, claim.leaseToken, { cursor: { stage: "nope" } as never }),
		).rejects.toThrow();
	});

	it("refuses to claim an operation written by another runtime generation", async () => {
		const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ runtime_generation: TRANSFER_RUNTIME_GENERATION + 1 })
			.where("id", "=", operation.id)
			.execute();
		expect(await codeOf(repo.claim(operation.id, ["pending"]))).toBe("TRANSFER_RUNTIME_MISMATCH");
		expect(await codeOf(repo.claim("missing", ["pending"]))).toBe("TRANSFER_OPERATION_NOT_FOUND");
	});

	it("cancels immediately without a lease and by request with one", async () => {
		const idle = await repo.create({ kind: "import", createdBy: "u1" });
		expect((await repo.requestCancel(idle.operation.id)).state).toBe("cancelled");
		expect(await codeOf(repo.requestCancel(idle.operation.id))).toBe("TRANSFER_INVALID_STATE");

		const busy = await repo.create({ kind: "import", createdBy: "u1" });
		const claim = await repo.claim(busy.operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		const flagged = await repo.requestCancel(busy.operation.id);
		expect(flagged.state).toBe("uploading");
		expect(flagged.cancelRequestedAt).not.toBeNull();
		const cancelled = await repo.finishCancelled(busy.operation.id, claim.leaseToken);
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.leaseToken).toBeNull();

		const exported = await repo.create({ kind: "export", createdBy: "u1" });
		expect(await codeOf(repo.requestCancel(exported.operation.id))).toBe("TRANSFER_INVALID_STATE");
	});

	it("only abandons failed or cancelled imports", async () => {
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		expect(await codeOf(repo.abandon(operation.id))).toBe("TRANSFER_INVALID_STATE");
		await repo.requestCancel(operation.id);
		expect((await repo.abandon(operation.id)).state).toBe("abandoned");
	});

	it("records mutation start once", async () => {
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		const claim = await repo.claim(operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		const first = await repo.advance(operation.id, claim.leaseToken, {
			state: "running",
			markMutationStarted: true,
		});
		const second = await repo.advance(operation.id, claim.leaseToken, {
			markMutationStarted: true,
		});
		expect(first.mutationStartedAt).not.toBeNull();
		expect(second.mutationStartedAt).toBe(first.mutationStartedAt);
	});

	it("expires pending imports and exports past their TTL, never running imports", async () => {
		const pendingImport = await repo.create({ kind: "import", createdBy: "u1", ttlSeconds: -1 });
		const exported = await repo.create({ kind: "export", createdBy: "u1", ttlSeconds: -1 });
		const fresh = await repo.create({ kind: "export", createdBy: "u1" });
		const expired = await repo.expireDue();
		expect(expired.map((operation) => operation.id).toSorted()).toEqual(
			[pendingImport.operation.id, exported.operation.id].toSorted(),
		);
		expect((await repo.require(fresh.operation.id)).state).toBe("pending");

		const running = await repo.create({ kind: "import", createdBy: "u1", ttlSeconds: -1 });
		const claim = await repo.claim(running.operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.release(running.operation.id, claim.leaseToken, {
			state: "running",
			markMutationStarted: true,
		});
		expect(await repo.expireDue()).toEqual([]);
	});

	it("bumps the write epoch of running exports only", async () => {
		const running = await repo.create({ kind: "export", createdBy: "u1" });
		const pending = await repo.create({ kind: "export", createdBy: "u1" });
		const claim = await repo.claim(running.operation.id, ["pending"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.advance(running.operation.id, claim.leaseToken, { state: "running" });
		expect(await repo.recordWriteForRunningExports()).toBe(1);
		expect(await repo.recordWriteForRunningExports()).toBe(1);
		expect((await repo.require(running.operation.id)).writeEpoch).toBe(2);
		expect((await repo.require(pending.operation.id)).writeEpoch).toBe(0);
	});

	it("lists operations newest first with a cursor", async () => {
		const created: string[] = [];
		for (let i = 0; i < 5; i++)
			created.push((await repo.create({ kind: "export", createdBy: "u1" })).operation.id);
		const first = await repo.list({ kind: "export", limit: 2 });
		expect(first.items).toHaveLength(2);
		const second = await repo.list({ kind: "export", limit: 2, cursor: first.next });
		const third = await repo.list({ kind: "export", limit: 2, cursor: second.next });
		expect(third.next).toBeUndefined();
		const listed = [...first.items, ...second.items, ...third.items].map(
			(operation) => operation.id,
		);
		expect(new Set(listed)).toEqual(new Set(created));
	});

	it("never lists the staging secret or lease token", async () => {
		const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
		await repo.claim(operation.id, ["pending"]);
		const { items } = await repo.list();
		expect(items).toHaveLength(1);
		expect(JSON.stringify(items)).not.toContain(operation.stagingSecret);
		expect("leaseToken" in items[0]!).toBe(false);
		expect("stagingSecret" in toPublicOperation(operation)).toBe(false);
	});

	it("never expires an import that already started writing", async () => {
		const { operation } = await repo.create({ kind: "import", createdBy: "u1", ttlSeconds: -1 });
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "planned", mutation_started_at: "2026-01-01T00:00:00.000Z" })
			.where("id", "=", operation.id)
			.execute();
		expect(await repo.expireDue()).toEqual([]);
		expect((await repo.require(operation.id)).state).toBe("planned");
	});

	it("lists terminal operations until their staging is collected", async () => {
		const staged = new TransferStagedFileRepository(ctx.db);
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		const running = await repo.create({ kind: "export", createdBy: "u1" });
		const complete = await repo.create({ kind: "export", createdBy: "u1" });
		const claim = await repo.claim(complete.operation.id, ["pending"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.complete(complete.operation.id, claim.leaseToken);

		await staged.declareMany(
			operation.id,
			Array.from({ length: 7 }, (_, i) => ({
				path: `records/entry/${String(i).padStart(6, "0")}.ndjson`,
				bytes: 1,
				sha256: "a".repeat(64),
			})),
		);
		await new TransferPackageIndexRepository(ctx.db, operation.id).insertMany(
			Array.from({ length: 4 }, (_, i) => ({ kind: "entry" as const, id: `e${i}` })),
		);

		expect(await repo.listUncollected()).toEqual([]);
		await repo.requestCancel(operation.id);
		const uncollected = await repo.listUncollected();
		expect(uncollected.map((item) => item.id)).toEqual([operation.id]);
		expect(uncollected[0]?.stagingSecret).toBe(operation.stagingSecret);
		expect(uncollected.map((item) => item.id)).not.toContain(running.operation.id);
		expect(uncollected.map((item) => item.id)).not.toContain(complete.operation.id);

		expect(await repo.deleteIfChildless(operation.id)).toBe(false);
		let deleted = 0;
		for (let round = 0; round < 10; round++) {
			const batch = await repo.deleteChildRows(operation.id, 3);
			expect(batch).toBeLessThanOrEqual(6);
			if (batch === 0) break;
			deleted += batch;
		}
		expect(deleted).toBe(11);
		await repo.markCollected(operation.id);
		expect(await repo.listUncollected()).toEqual([]);
		expect((await repo.require(operation.id)).stagingCollectedAt).not.toBeNull();
		expect(await repo.deleteIfChildless(operation.id)).toBe(true);
		expect(await repo.get(operation.id)).toBeNull();
	});
});
