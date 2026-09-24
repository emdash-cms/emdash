import { afterEach, beforeEach, expect, it } from "vitest";

import { runSystemCleanup } from "../../../src/cleanup.js";
import { collectTransferStaging } from "../../../src/transfer/gc.js";
import { TransferApprovalRepository } from "../../../src/transfer/ops/approvals.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../../src/transfer/ops/staged-files.js";
import { stagingPrefix } from "../../../src/transfer/staging/keys.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";

const LONG_AGO = "2020-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const SHA = "0".repeat(64);

describeEachDialect("transfer staging collection", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function stagedOperation(
		kind: "import" | "export",
		state: string,
		options: {
			updatedAt?: string;
			expiresAt?: string;
			mutationStarted?: boolean;
			files?: number;
		} = {},
	): Promise<{ id: string; prefix: string }> {
		const operations = new TransferOperationRepository(ctx.db);
		const { operation } = await operations.create({ kind, createdBy: "admin-1" });
		const prefix = stagingPrefix(kind, operation.id, operation.stagingSecret);
		const files = options.files ?? 3;
		const declared = [];
		for (let index = 0; index < files; index++) {
			const path = `records/entry/${String(index).padStart(6, "0")}.ndjson`;
			storage.files.set(`${prefix}${path}`, {
				body: new Uint8Array([index]),
				contentType: "application/octet-stream",
				lastModified: new Date(),
			});
			declared.push({ path, bytes: 1, sha256: SHA });
		}
		for (const aux of ["_plan.json", "_analysis/state-abc.json", "_analysis/context.json"]) {
			storage.files.set(`${prefix}${aux}`, {
				body: new Uint8Array([1]),
				contentType: "application/json",
				lastModified: new Date(),
			});
		}
		await new TransferStagedFileRepository(ctx.db).declareMany(operation.id, declared);
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({
				state,
				updated_at: options.updatedAt ?? LONG_AGO,
				expires_at: options.expiresAt ?? FAR_FUTURE,
				mutation_started_at: options.mutationStarted ? LONG_AGO : null,
				receipt: null,
			})
			.where("id", "=", operation.id)
			.execute();
		return { id: operation.id, prefix };
	}

	function objectsUnder(prefix: string): string[] {
		return [...storage.files.keys()].filter((key) => key.startsWith(prefix));
	}

	async function stagedRows(id: string): Promise<number> {
		const counts = await new TransferStagedFileRepository(ctx.db).countByState(id);
		return counts.declared + counts.verified;
	}

	async function collectedAt(id: string): Promise<string | null> {
		return (await new TransferOperationRepository(ctx.db).require(id)).stagingCollectedAt;
	}

	it("collects a finished import's objects, analysis state, and rows after retention", async () => {
		const done = await stagedOperation("import", "complete");
		const recent = await stagedOperation("import", "abandoned", {
			updatedAt: new Date().toISOString(),
		});

		const result = await collectTransferStaging(ctx.db, storage);

		expect(result.collected).toBe(1);
		expect(objectsUnder(done.prefix)).toEqual([]);
		expect(await stagedRows(done.id)).toBe(0);
		expect(await collectedAt(done.id)).not.toBeNull();
		expect(await new TransferOperationRepository(ctx.db).get(done.id)).not.toBeNull();

		expect(objectsUnder(recent.prefix)).toHaveLength(6);
		expect(await stagedRows(recent.id)).toBe(3);
		expect(await collectedAt(recent.id)).toBeNull();
	});

	it("expires overdue pending imports and collects them in the same tick", async () => {
		const pending = await stagedOperation("import", "uploading", {
			updatedAt: new Date().toISOString(),
			expiresAt: LONG_AGO,
		});

		const result = await collectTransferStaging(ctx.db, storage);

		expect(result.expired).toBe(1);
		expect((await new TransferOperationRepository(ctx.db).require(pending.id)).state).toBe(
			"expired",
		);
		expect(objectsUnder(pending.prefix)).toEqual([]);
		expect(await collectedAt(pending.id)).not.toBeNull();
	});

	it("keeps a complete export until it expires, then collects it", async () => {
		const exported = await stagedOperation("export", "complete");
		await collectTransferStaging(ctx.db, storage);
		expect(objectsUnder(exported.prefix)).toHaveLength(6);

		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ expires_at: LONG_AGO })
			.where("id", "=", exported.id)
			.execute();
		await collectTransferStaging(ctx.db, storage);
		expect(objectsUnder(exported.prefix)).toEqual([]);
		expect(await collectedAt(exported.id)).not.toBeNull();
	});

	it("never collects an import that is running or holds the write fence", async () => {
		const running = await stagedOperation("import", "running", { mutationStarted: true });
		const exporting = await stagedOperation("export", "running");
		await collectTransferStaging(ctx.db, storage);
		expect(objectsUnder(running.prefix)).toHaveLength(6);
		expect(objectsUnder(exporting.prefix)).toHaveLength(6);
	});

	it("stops at its budget and resumes on the next tick", async () => {
		const first = await stagedOperation("import", "failed", { files: 10 });
		const second = await stagedOperation("import", "cancelled", { files: 2 });

		const tick = await collectTransferStaging(ctx.db, storage, { objects: 5 });
		expect(tick.objectsDeleted).toBe(5);
		expect(tick.collected).toBe(0);
		expect(await collectedAt(first.id)).toBeNull();

		for (let ticks = 0; ticks < 10; ticks++) {
			await collectTransferStaging(ctx.db, storage, { objects: 5 });
		}
		expect(objectsUnder(first.prefix)).toEqual([]);
		expect(objectsUnder(second.prefix)).toEqual([]);
		expect(await collectedAt(first.id)).not.toBeNull();
		expect(await collectedAt(second.id)).not.toBeNull();
		expect(await stagedRows(first.id)).toBe(0);
	});

	it("expires overdue approval grants", async () => {
		const approvals = new TransferApprovalRepository(ctx.db);
		const approval = await approvals.createPending({
			userId: "admin-1",
			action: "export",
			ttlSeconds: -1,
		});
		await collectTransferStaging(ctx.db, storage);
		expect((await approvals.get(approval.id))?.status).toBe("expired");
	});

	it("runs from system cleanup", async () => {
		const done = await stagedOperation("import", "complete");
		const result = await runSystemCleanup(ctx.db, storage);
		expect(result.transferStaging).toBe(1);
		expect(objectsUnder(done.prefix)).toEqual([]);
	});
});
