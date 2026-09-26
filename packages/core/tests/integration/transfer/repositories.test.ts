import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TransferError } from "../../../src/transfer/errors.js";
import { TransferApprovalRepository } from "../../../src/transfer/ops/approvals.js";
import { TransferIdentityMapRepository } from "../../../src/transfer/ops/identity-map.js";
import { TransferMediaBlobRepository } from "../../../src/transfer/ops/media-blobs.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { TransferPackageIndexRepository } from "../../../src/transfer/ops/package-index.js";
import { TransferStagedFileRepository } from "../../../src/transfer/ops/staged-files.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PACKAGE = `sha256:${SHA_A}` as const;
const PLAN = `sha256:${SHA_B}` as const;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof TransferError ? error.code : String(error);
	}
	return undefined;
}

describeEachDialect("transfer repositories", (dialect) => {
	let ctx: DialectTestContext;
	let operationId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		operationId = (
			await new TransferOperationRepository(ctx.db).create({ kind: "import", createdBy: "u1" })
		).operation.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	describe("identity map", () => {
		it("records mappings idempotently and rejects conflicting ones", async () => {
			const map = new TransferIdentityMapRepository(ctx.db, "origin", operationId);
			const mappings = Array.from({ length: 45 }, (_, i) => ({
				portableId: `p${String(i).padStart(3, "0")}`,
				targetId: `t${i}`,
			}));
			await map.putMany("media_storage_key", mappings);
			await map.putMany("media_storage_key", mappings);
			expect(await map.get("media_storage_key", "p001")).toBe("t1");
			expect((await map.getMany("media_storage_key", ["p000", "p044", "zzz"])).size).toBe(2);
			expect((await map.getPortableIds("media_storage_key", ["t2"])).get("t2")).toBe("p002");
			expect(await map.get("entry", "p001")).toBeNull();

			expect(
				await codeOf(map.put("media_storage_key", { portableId: "p001", targetId: "different" })),
			).toBe("TRANSFER_REFERENCE_INVALID");

			const page = await map.list("media_storage_key", { limit: 10 });
			expect(page.map((mapping) => mapping.portableId)).toEqual(
				mappings.slice(0, 10).map((m) => m.portableId),
			);
			const next = await map.list("media_storage_key", {
				limit: 10,
				after: page.at(-1)!.portableId,
			});
			expect(next[0]?.portableId).toBe("p010");
		});

		it("scopes mappings to the import operation", async () => {
			const operations = new TransferOperationRepository(ctx.db);
			await operations.requestCancel(operationId);
			await operations.abandon(operationId);
			const second = (await operations.create({ kind: "import", createdBy: "u1" })).operation.id;

			const first = new TransferIdentityMapRepository(ctx.db, "origin", operationId);
			const next = new TransferIdentityMapRepository(ctx.db, "origin", second);
			await first.put("media_storage_key", { portableId: "m1", targetId: "old-key.jpg" });
			await next.put("media_storage_key", { portableId: "m1", targetId: "new-key.jpg" });
			expect(await next.get("media_storage_key", "m1")).toBe("new-key.jpg");
			expect((await next.getPortableIds("media_storage_key", ["old-key.jpg"])).size).toBe(0);
			expect(await first.get("media_storage_key", "m1")).toBe("old-key.jpg");
		});
	});

	describe("staged files", () => {
		it("declares, verifies, and lists files in path order", async () => {
			const files = new TransferStagedFileRepository(ctx.db);
			const declared = [
				{ path: `media/${SHA_B}`, bytes: 3_000_000_000, sha256: SHA_B },
				{ path: "records/entry/000000.ndjson", bytes: 10, sha256: SHA_A },
				{ path: "records/taxonomy_def/000000.ndjson", bytes: 11, sha256: SHA_A },
				{ path: "records/term/000000.ndjson", bytes: 12, sha256: SHA_A },
			];
			await files.declareMany(operationId, declared);
			await files.declareMany(operationId, declared);
			expect(await codeOf(files.declareMany(operationId, [{ ...declared[1]!, bytes: 99 }]))).toBe(
				"TRANSFER_FILE_DIGEST_MISMATCH",
			);

			expect(await files.markVerified(operationId, { ...declared[1]!, sha256: SHA_B })).toBe(false);
			expect(await files.markVerified(operationId, declared[1]!)).toBe(true);
			expect(await files.countByState(operationId)).toEqual({ declared: 3, verified: 1 });

			const big = await files.get(operationId, `media/${SHA_B}`);
			expect(big?.bytes).toBe(3_000_000_000);

			const records = await files.list(operationId, { prefix: "records/t" });
			expect(records.map((file) => file.path)).toEqual([
				"records/taxonomy_def/000000.ndjson",
				"records/term/000000.ndjson",
			]);
			const underscore = await files.list(operationId, { prefix: "records/taxonomy_" });
			expect(underscore).toHaveLength(1);
			const pending = await files.list(operationId, { state: "declared", limit: 2 });
			expect(pending.map((file) => file.path)).toEqual([
				`media/${SHA_B}`,
				"records/taxonomy_def/000000.ndjson",
			]);
			const after = await files.list(operationId, {
				state: "declared",
				after: pending.at(-1)!.path,
			});
			expect(after.map((file) => file.path)).toEqual(["records/term/000000.ndjson"]);

			await files.setLogicalSha256(operationId, "records/entry/000000.ndjson", SHA_B);
			expect((await files.get(operationId, "records/entry/000000.ndjson"))?.logicalSha256).toBe(
				SHA_B,
			);

			expect(await files.deleteForOperation(operationId, 2)).toBe(2);
			expect(await files.deleteForOperation(operationId)).toBe(2);
			expect(await files.list(operationId)).toEqual([]);
		});
	});

	describe("package index", () => {
		it("finds missing references by id, group, and name, and reports depths", async () => {
			const index = new TransferPackageIndexRepository(ctx.db, operationId);
			await index.insertMany([
				{ kind: "collection", id: "c1", nameKey: "posts" },
				{ kind: "entry", id: "e1", groupId: "g1" },
				{ kind: "entry", id: "e2", groupId: "g1" },
				{ kind: "term", id: "t1", groupId: "t1" },
				{ kind: "term", id: "t2", groupId: "t2", parentId: "t1", depth: 1 },
			]);
			await index.insertMany([{ kind: "entry", id: "e1", groupId: "g1" }]);
			expect(await index.count()).toBe(5);
			expect(await index.count("entry")).toBe(2);
			expect(await index.findMissing(["entry"], "id", ["e1", "e9"])).toEqual(["e9"]);
			expect(await index.findMissing(["entry", "term"], "group", ["g1", "t2", "gx"])).toEqual([
				"gx",
			]);
			expect(await index.findMissing(["collection"], "slug", ["posts", "pages"])).toEqual([
				"pages",
			]);
			expect(await index.depths("term", ["t1", "t2", "t9"])).toEqual(
				new Map([
					["t1", 0],
					["t2", 1],
				]),
			);
			expect(await index.get("term", "t2")).toEqual({
				kind: "term",
				id: "t2",
				groupId: "t2",
				parentId: "t1",
				nameKey: null,
				depth: 1,
			});
			expect(await index.deleteSome(3)).toBe(3);
			expect(await index.count()).toBe(2);
		});
	});

	describe("media blobs", () => {
		it("records blob digests per media row and summarizes distinct blobs", async () => {
			const blobs = new TransferMediaBlobRepository(ctx.db, operationId);
			await blobs.putMany([
				{ mediaId: "m1", sha256: SHA_A, bytes: 10 },
				{ mediaId: "m2", sha256: SHA_A, bytes: 10 },
				{ mediaId: "m3", sha256: SHA_B, bytes: 5 },
			]);
			await blobs.putMany([{ mediaId: "m3", sha256: SHA_B, bytes: 6 }]);
			expect((await blobs.getMany(["m3"])).get("m3")).toEqual({
				mediaId: "m3",
				sha256: SHA_B,
				bytes: 6,
			});
			expect(await blobs.totals()).toEqual({ mediaRows: 3, blobs: 2, blobBytes: 16 });
			expect(await blobs.listDistinctBlobs()).toEqual([
				{ sha256: SHA_A, bytes: 10 },
				{ sha256: SHA_B, bytes: 6 },
			]);
			expect((await blobs.list({ after: "m1" })).map((entry) => entry.mediaId)).toEqual([
				"m2",
				"m3",
			]);
		});
	});

	describe("approvals", () => {
		it("approves once and consumes only with a matching binding", async () => {
			const approvals = new TransferApprovalRepository(ctx.db);
			const binding = {
				userId: "u1",
				action: "import" as const,
				operationId,
				packageDigest: PACKAGE,
				planDigest: PLAN,
				tokenId: "tok",
			};
			const pending = await approvals.createPending({ ...binding, requestedByTokenId: "tok" });
			expect(pending.status).toBe("pending");
			expect(await codeOf(approvals.consume(pending.id, binding))).toBe(
				"TRANSFER_APPROVAL_INVALID",
			);

			const approved = await approvals.approve(pending.id, "admin");
			expect(approved.status).toBe("approved");
			expect(approved.approvedBy).toBe("admin");
			expect(await codeOf(approvals.approve(pending.id, "admin"))).toBe(
				"TRANSFER_APPROVAL_INVALID",
			);

			for (const wrong of [
				{ ...binding, userId: "u2" },
				{ ...binding, action: "export" as const },
				{ ...binding, planDigest: PACKAGE },
				{ ...binding, operationId: "other" },
				{ ...binding, paramsDigest: PLAN },
				{ userId: "u1", action: "import" as const, packageDigest: PACKAGE, planDigest: PLAN },
				{ ...binding, tokenId: "other-token" },
				{ ...binding, tokenId: undefined },
			]) {
				expect(await codeOf(approvals.consume(pending.id, wrong))).toBe(
					"TRANSFER_APPROVAL_INVALID",
				);
			}
			const consumed = await approvals.consume(pending.id, binding);
			expect(consumed.status).toBe("consumed");
			expect(await codeOf(approvals.consume(pending.id, binding))).toBe(
				"TRANSFER_APPROVAL_INVALID",
			);
		});

		it("requires digests for import approvals", async () => {
			const approvals = new TransferApprovalRepository(ctx.db);
			expect(await codeOf(approvals.createPending({ userId: "u1", action: "import" }))).toBe(
				"TRANSFER_APPROVAL_INVALID",
			);
			const exportApproval = await approvals.createPending({ userId: "u1", action: "export" });
			await approvals.approve(exportApproval.id, "admin");
			expect(
				(await approvals.consume(exportApproval.id, { userId: "u1", action: "export" })).status,
			).toBe("consumed");
		});

		it("never approves or consumes an expired grant and expires stale ones", async () => {
			const approvals = new TransferApprovalRepository(ctx.db);
			const stale = await approvals.createPending({
				userId: "u1",
				action: "export",
				ttlSeconds: -1,
			});
			expect(await codeOf(approvals.approve(stale.id, "admin"))).toBe("TRANSFER_APPROVAL_INVALID");

			const lapsed = await approvals.createPending({ userId: "u1", action: "export" });
			await approvals.approve(lapsed.id, "admin", { ttlSeconds: -1 });
			expect(await codeOf(approvals.consume(lapsed.id, { userId: "u1", action: "export" }))).toBe(
				"TRANSFER_APPROVAL_INVALID",
			);
			expect(await approvals.expireDue()).toBe(2);
			expect((await approvals.get(lapsed.id))?.status).toBe("expired");
		});

		it("denies and lists approvals", async () => {
			const approvals = new TransferApprovalRepository(ctx.db);
			const a = await approvals.createPending({ userId: "u1", action: "export" });
			await approvals.createPending({ userId: "u2", action: "export" });
			await approvals.createPending({ userId: "u1", action: "export" });
			expect((await approvals.deny(a.id, "admin")).status).toBe("denied");
			const pendingForU1 = await approvals.list({ userId: "u1", status: "pending" });
			expect(pendingForU1.items).toHaveLength(1);
			const first = await approvals.list({ limit: 2 });
			const second = await approvals.list({ limit: 2, cursor: first.next });
			expect(first.items).toHaveLength(2);
			expect(second.items).toHaveLength(1);
			expect(second.next).toBeUndefined();
		});
	});
});
