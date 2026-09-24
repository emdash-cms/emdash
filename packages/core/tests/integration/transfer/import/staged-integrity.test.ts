/**
 * Staged package files that change after they were verified: an upload that
 * stalls and lands after another upload of the same path verified it, and
 * staged bytes replaced after analysis. Import and verification must refuse
 * the changed bytes rather than import or vouch for them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleImportAnalyze,
	handleImportCreate,
	handleImportFileUpload,
} from "../../../../src/api/handlers/transfer.js";
import type { ApiResult } from "../../../../src/api/types.js";
import { analysisTargetContext } from "../../../../src/transfer/analyze/target.js";
import { verifyImportStep } from "../../../../src/transfer/export/verify.js";
import type { Sha256Digest } from "../../../../src/transfer/format/digest.js";
import { MANIFEST_PATH, parsePackagePath } from "../../../../src/transfer/format/paths.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import { advanceImport, requestImportExecution } from "../../../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import { stagingPrefix } from "../../../../src/transfer/staging/keys.js";
import { StagedPackageReader } from "../../../../src/transfer/staging/package.js";
import { readStreamBytes, TransferStage } from "../../../../src/transfer/staging/stage.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { buildGoldenPackage, type GoldenPackage } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { seedTarget } from "./harness.js";

const TARGET = analysisTargetContext({
	i18n: { defaultLocale: "en", locales: ["en", "FR"] },
	maxUploadSize: 50 * 1024 * 1024,
	emdashVersion: "0.0.0-test",
});
const COMMENTS = "records/comment/000000.ndjson";
const MAX_BLOB = 50 * 1024 * 1024;

function unwrap<T>(result: ApiResult<T>): T {
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}

/** A body that sends `bytes` but does not end until `release` is called. */
function stalledBody(bytes: Uint8Array): { body: ReadableStream<Uint8Array>; release: () => void } {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(bytes);
			await released;
			controller.close();
		},
	});
	return { body, release };
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new Blob([bytes]).stream();
}

describeEachDialect("staged package integrity", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let golden: GoldenPackage;
	let original: Uint8Array;
	let tampered: Uint8Array;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await seedTarget(ctx.db);
		storage = createMemoryStorage();
		golden = await buildGoldenPackage(createMemoryStorage());
		original = await golden.stage.readBytes(COMMENTS, 8 * 1024 * 1024);
		const text = new TextDecoder().decode(original);
		expect(text).toContain("Great post!");
		tampered = new TextEncoder().encode(text.replace("Great post!", "Evil post!!"));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function upload(
		operationId: string,
		path: string,
		body: ReadableStream<Uint8Array>,
		bytes: number,
	) {
		return handleImportFileUpload(ctx.db, storage, {
			operationId,
			path,
			contentLength: bytes,
			body,
			maxBlobBytes: MAX_BLOB,
		});
	}

	/** Create the import and upload every file except `skip`. */
	async function uploadPackage(skip: string): Promise<string> {
		const manifest = await golden.stage.readBytes(MANIFEST_PATH, 8 * 1024 * 1024);
		const { operation } = unwrap(
			await handleImportCreate(ctx.db, storage, { userId: "admin", manifest }),
		);
		for (const ref of golden.manifest.index) {
			const bytes = await golden.stage.readBytes(ref.path, ref.bytes);
			unwrap(await upload(operation.id, ref.path, bodyOf(bytes), ref.bytes));
		}
		for await (const { entry } of golden.reader.index()) {
			if (entry.path === skip) continue;
			const parsed = parsePackagePath(entry.path);
			const bytes =
				parsed?.type === "media"
					? await readStreamBytes(await golden.reader.blob(parsed.sha256), entry.bytes)
					: await golden.stage.readBytes(entry.path, entry.bytes);
			unwrap(await upload(operation.id, entry.path, bodyOf(bytes), entry.bytes));
		}
		return operation.id;
	}

	async function analyze(operationId: string): Promise<{ plan: SiteImportPlan; digest: string }> {
		for (let step = 0; step < 1000; step++) {
			const result = unwrap(
				await handleImportAnalyze(ctx.db, storage, { operationId, target: TARGET }),
			);
			if (result.nextRequestInMs === null) {
				expect(result.plan?.blockers).toEqual([]);
				return { plan: result.plan!, digest: result.planDigest! };
			}
		}
		throw new Error("analysis did not finish");
	}

	async function execute(operationId: string, plan: SiteImportPlan, digest: string) {
		await requestImportExecution({
			db: ctx.db,
			operationId,
			packageDigest: plan.packageDigest as Sha256Digest,
			planDigest: digest as Sha256Digest,
		});
		for (let step = 0; step < 1000; step++) {
			const result = await advanceImport({
				db: ctx.db,
				storage,
				operationId,
				verify: verifyImportStep,
			});
			if (result.nextRequestInMs === null) return result.operation;
		}
		throw new Error("import did not finish");
	}

	async function stagedBytes(operationId: string, path: string): Promise<Uint8Array> {
		const operation = await new TransferOperationRepository(ctx.db).require(operationId);
		const stage = new TransferStage(
			storage,
			stagingPrefix("import", operationId, operation.stagingSecret),
		);
		return stage.readBytes(path, 8 * 1024 * 1024);
	}

	async function commentBodies(): Promise<string[]> {
		const rows = await ctx.db.selectFrom("_emdash_comments").select("body").execute();
		return rows.map((row) => row.body);
	}

	describe("an upload that stalls until after analysis", () => {
		it("cannot change what is imported, and no receipt vouches for it", async () => {
			const operationId = await uploadPackage(COMMENTS);
			const stalled = stalledBody(tampered);
			const late = upload(operationId, COMMENTS, stalled.body, tampered.byteLength);
			unwrap(await upload(operationId, COMMENTS, bodyOf(original), original.byteLength));
			const { plan, digest } = await analyze(operationId);

			stalled.release();
			expect((await late).success).toBe(false);
			expect(await stagedBytes(operationId, COMMENTS)).toEqual(tampered);

			const operation = await execute(operationId, plan, digest);
			expect(operation.state).toBe("failed");
			expect(operation.errorCode).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
			expect(operation.receipt).toBeNull();
			expect(await commentBodies()).not.toContain("Evil post!!");
		});

		it("is refused once analysis has started, even with the right bytes", async () => {
			const operationId = await uploadPackage(COMMENTS);
			const stalled = stalledBody(original);
			const late = upload(operationId, COMMENTS, stalled.body, original.byteLength);
			unwrap(await upload(operationId, COMMENTS, bodyOf(original), original.byteLength));
			await analyze(operationId);

			stalled.release();
			const result = await late;
			expect(result.success).toBe(false);
			expect(!result.success && result.error.code).toBe("TRANSFER_INVALID_STATE");
		});
	});

	it("compares a re-upload of a verified path without writing it", async () => {
		const operationId = await uploadPackage(COMMENTS);
		unwrap(await upload(operationId, COMMENTS, bodyOf(original), original.byteLength));
		const writes: string[] = [];
		storage.beforeUpload = (key) => writes.push(key);

		const again = await upload(operationId, COMMENTS, bodyOf(tampered), tampered.byteLength);
		expect(!again.success && again.error.code).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
		expect(
			unwrap(await upload(operationId, COMMENTS, bodyOf(original), original.byteLength)),
		).toMatchObject({ alreadyVerified: true });
		expect(writes).toEqual([]);
		expect(await stagedBytes(operationId, COMMENTS)).toEqual(original);
	});

	it("fails verification of a record chunk replaced after the import", async () => {
		const operationId = await uploadPackage("");
		const { plan, digest } = await analyze(operationId);
		const operation = await execute(operationId, plan, digest);
		expect(operation.state).toBe("complete");
		expect(await commentBodies()).toContain("Great post!");

		const stage = new TransferStage(
			storage,
			stagingPrefix("import", operationId, operation.stagingSecret),
		);
		await storage.upload({
			key: stage.keyFor(COMMENTS),
			body: tampered,
			contentType: "application/octet-stream",
		});
		const verifying = verifyImportStep({
			db: ctx.db,
			storage,
			operationId,
			reader: new StagedPackageReader(stage),
			plan,
			cursor: null,
			budget: new TransferStepBudget(),
		});
		await expect(verifying).rejects.toMatchObject({ code: "TRANSFER_FILE_DIGEST_MISMATCH" });
	});
});
