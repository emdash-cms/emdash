/**
 * Transfer actions write audit log entries naming the actor, the operation or
 * approval, and digests and counts only.
 */

import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	exportParamsDigest,
	handleApprovalDecide,
	handleExportCreate,
	handleImportAbandon,
	handleImportAdvance,
	handleImportAnalyze,
	handleImportCancel,
	handleImportCreate,
	handleImportExecute,
	handleImportFileUpload,
	handleImportMissing,
	requestTransferApproval,
} from "../../../src/api/handlers/transfer.js";
import { AuditRepository, type AuditLog } from "../../../src/database/repositories/audit.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { analysisTargetContext } from "../../../src/transfer/analyze/target.js";
import type { Sha256Digest } from "../../../src/transfer/format/digest.js";
import { MANIFEST_PATH } from "../../../src/transfer/format/paths.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { buildGoldenPackage } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";

const ADMIN = { id: "admin-1", role: Role.ADMIN };
const OTHER_ADMIN = { id: "admin-2", role: Role.ADMIN };
const GOLDEN_PREFIX = "transfers/fixtures/golden/";
const TARGET = analysisTargetContext({
	i18n: { defaultLocale: "en", locales: ["en", "fr"] },
	maxUploadSize: 50 * 1024 * 1024,
});
/** Values in the golden package that no audit entry may contain. */
const GOLDEN_CONTENT = ["alice@example.com", "Golden Site", "Bonjour le monde", "Coming soon"];

describeEachDialect("site transfer audit log", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let packageFiles: Map<string, Uint8Array>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await applySeed(ctx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		storage = createMemoryStorage();
		const source = createMemoryStorage();
		await buildGoldenPackage(source, { prefix: GOLDEN_PREFIX });
		packageFiles = new Map(
			Array.from(source.files, ([key, file]) => [key.slice(GOLDEN_PREFIX.length), file.body]),
		);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	/** Entries by action, since several can share a timestamp. */
	async function entries(): Promise<Map<string, AuditLog>> {
		const { items } = await new AuditRepository(ctx.db).findMany({ limit: 100 });
		const byAction = new Map(items.map((item) => [item.action, item]));
		expect(byAction.size).toBe(items.length);
		return byAction;
	}

	function unwrap<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
		if (!result.success) throw new Error(JSON.stringify(result.error));
		return result.data;
	}

	async function plannedImport(): Promise<{
		id: string;
		packageDigest: Sha256Digest;
		planDigest: Sha256Digest;
	}> {
		const created = unwrap(
			await handleImportCreate(ctx.db, storage, {
				userId: ADMIN.id,
				manifest: packageFiles.get(MANIFEST_PATH)!,
			}),
		);
		const id = created.operation.id;
		for (;;) {
			const missing = unwrap(await handleImportMissing(ctx.db, id, { limit: 100 }));
			if (missing.items.length === 0) break;
			for (const file of missing.items) {
				const bytes = packageFiles.get(file.path)!;
				unwrap(
					await handleImportFileUpload(ctx.db, storage, {
						operationId: id,
						path: file.path,
						contentLength: bytes.byteLength,
						body: new Response(bytes).body,
						maxBlobBytes: 50 * 1024 * 1024,
					}),
				);
			}
		}
		for (;;) {
			const step = unwrap(
				await handleImportAnalyze(ctx.db, storage, { operationId: id, target: TARGET }),
			);
			if (step.nextRequestInMs === null) {
				return {
					id,
					packageDigest: step.operation.packageDigest!,
					planDigest: step.planDigest!,
				};
			}
		}
	}

	async function advanceToEnd(id: string, userId: string): Promise<string> {
		for (;;) {
			const step = unwrap(await handleImportAdvance(ctx.db, storage, { operationId: id, userId }));
			if (step.nextRequestInMs === null) return step.operation.state;
		}
	}

	function expectNoPackageContent(logs: Map<string, AuditLog>): void {
		const text = JSON.stringify([...logs.values()]);
		for (const value of GOLDEN_CONTENT) expect(text).not.toContain(value);
	}

	it("records an import from creation to completion", async () => {
		const planned = await plannedImport();
		unwrap(
			await handleImportExecute(ctx.db, storage, {
				operationId: planned.id,
				userId: ADMIN.id,
				packageDigest: planned.packageDigest,
				planDigest: planned.planDigest,
			}),
		);
		unwrap(
			await handleImportExecute(ctx.db, storage, {
				operationId: planned.id,
				userId: ADMIN.id,
				packageDigest: planned.packageDigest,
				planDigest: planned.planDigest,
			}),
		);
		expect(await advanceToEnd(planned.id, OTHER_ADMIN.id)).toBe("complete");

		const logs = await entries();
		expect([...logs.keys()].toSorted()).toEqual([
			"transfer_import_complete",
			"transfer_import_create",
			"transfer_import_execute",
		]);
		const operation = {
			resourceType: "transfer_operation",
			resourceId: planned.id,
			status: "success",
		};
		expect(logs.get("transfer_import_create")).toMatchObject({
			...operation,
			actorId: ADMIN.id,
			details: { packageDigest: planned.packageDigest },
		});
		expect(logs.get("transfer_import_execute")).toMatchObject({
			...operation,
			actorId: ADMIN.id,
			details: { packageDigest: planned.packageDigest, planDigest: planned.planDigest },
		});
		expect(logs.get("transfer_import_complete")).toMatchObject({
			...operation,
			actorId: OTHER_ADMIN.id,
			details: {
				packageDigest: planned.packageDigest,
				planDigest: planned.planDigest,
				records: expect.any(Number),
			},
		});
		expectNoPackageContent(logs);
	});

	it("records an import that fails while executing", async () => {
		const planned = await plannedImport();
		unwrap(
			await handleImportExecute(ctx.db, storage, {
				operationId: planned.id,
				userId: ADMIN.id,
				packageDigest: planned.packageDigest,
				planDigest: planned.planDigest,
			}),
		);
		await ctx.db
			.insertInto("media_folders")
			.values({ id: "f1", name: "Late", name_key: "late" })
			.execute();
		expect(await advanceToEnd(planned.id, ADMIN.id)).toBe("failed");

		expect((await entries()).get("transfer_import_fail")).toMatchObject({
			actorId: ADMIN.id,
			action: "transfer_import_fail",
			resourceId: planned.id,
			status: "failure",
			details: { errorCode: "TRANSFER_TARGET_NOT_EMPTY" },
		});
	});

	it("records cancel and abandon", async () => {
		const created = unwrap(
			await handleImportCreate(ctx.db, storage, {
				userId: ADMIN.id,
				manifest: packageFiles.get(MANIFEST_PATH)!,
			}),
		);
		const id = created.operation.id;
		unwrap(await handleImportCancel(ctx.db, id, OTHER_ADMIN.id));
		unwrap(await handleImportAbandon(ctx.db, id, ADMIN.id));

		const logs = await entries();
		expect([...logs.keys()].toSorted()).toEqual([
			"transfer_import_abandon",
			"transfer_import_cancel",
			"transfer_import_create",
		]);
		expect(logs.get("transfer_import_cancel")).toMatchObject({
			actorId: OTHER_ADMIN.id,
			resourceType: "transfer_operation",
			resourceId: id,
		});
		expect(logs.get("transfer_import_abandon")).toMatchObject({
			actorId: ADMIN.id,
			resourceType: "transfer_operation",
			resourceId: id,
		});
	});

	it("records export creation once per export, and approval decisions", async () => {
		const created = unwrap(
			await handleExportCreate(ctx.db, { userId: ADMIN.id, options: {}, idempotencyKey: "k" }),
		);
		unwrap(
			await handleExportCreate(ctx.db, { userId: ADMIN.id, options: {}, idempotencyKey: "k" }),
		);

		const paramsDigest = await exportParamsDigest({});
		const approvalIds: string[] = [];
		for (let index = 0; index < 2; index++) {
			const pending = await requestTransferApproval(ctx.db, {
				userId: ADMIN.id,
				action: "export",
				paramsDigest,
				requestedByTokenId: `token-${index}`,
			});
			approvalIds.push(String(pending.error.details?.approvalId));
		}
		unwrap(
			await handleApprovalDecide(ctx.db, {
				approvalId: approvalIds[0]!,
				decision: "approve",
				user: OTHER_ADMIN,
			}),
		);
		unwrap(
			await handleApprovalDecide(ctx.db, {
				approvalId: approvalIds[1]!,
				decision: "deny",
				user: OTHER_ADMIN,
			}),
		);

		const logs = await entries();
		expect([...logs.keys()].toSorted()).toEqual([
			"transfer_approval_approve",
			"transfer_approval_deny",
			"transfer_export_create",
		]);
		expect(logs.get("transfer_export_create")).toMatchObject({
			actorId: ADMIN.id,
			resourceType: "transfer_operation",
			resourceId: created.operation.id,
		});
		expect(logs.get("transfer_approval_approve")).toMatchObject({
			actorId: OTHER_ADMIN.id,
			resourceType: "transfer_approval",
			resourceId: approvalIds[0],
			details: { action: "export", userId: ADMIN.id },
		});
		expect(logs.get("transfer_approval_deny")).toMatchObject({
			actorId: OTHER_ADMIN.id,
			resourceType: "transfer_approval",
			resourceId: approvalIds[1],
			details: { action: "export", userId: ADMIN.id },
		});
	});
});
