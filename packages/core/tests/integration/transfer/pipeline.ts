/**
 * Drives the whole transfer pipeline for integration tests: export an origin
 * site, upload it into a target's import staging the way a client does,
 * analyze, plan, and import with the real verifier. Every phase can run on
 * default step budgets or on a query-counted budget.
 */

import type { Kysely } from "kysely";
import { expect } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { analyzeImportStep, finalizePlan } from "../../../src/transfer/analyze/step.js";
import {
	analysisTargetContext,
	type AnalysisTargetContext,
} from "../../../src/transfer/analyze/target.js";
import { validateStagedPackageStep } from "../../../src/transfer/analyze/validate.js";
import {
	advanceExport,
	createExport,
	openExportPackage,
	type ExportPackageReader,
} from "../../../src/transfer/export/exporter.js";
import { verifyImportStep } from "../../../src/transfer/export/verify.js";
import {
	packageDigest,
	sha256Hex,
	type Sha256Digest,
} from "../../../src/transfer/format/digest.js";
import { MANIFEST_PATH, parsePackagePath } from "../../../src/transfer/format/paths.js";
import {
	advanceImport,
	requestImportExecution,
	type AdvanceImportResult,
} from "../../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../../src/transfer/ops/staged-files.js";
import { stagingPrefix } from "../../../src/transfer/staging/keys.js";
import { StagedPackageReader } from "../../../src/transfer/staging/package.js";
import { readStreamBytes, TransferStage } from "../../../src/transfer/staging/stage.js";
import type { MemoryStorage } from "../../utils/transfer/memory-storage.js";
import { withFaults, type FaultPlugin } from "./import/harness.js";

export const TARGET_BOB = "target_bob";

export const TARGET_CONTEXT = analysisTargetContext({
	i18n: { defaultLocale: "en", locales: ["en", "fr"] },
	emdashVersion: "0.0.0-test",
});

const MAX_STEPS = 2000;

function cursorOf(operation: { state: string; stage: string | null; cursor: unknown }): string {
	return JSON.stringify([operation.state, operation.stage, operation.cursor]).slice(0, 400);
}

type BudgetFactory = () => TransferStepBudget | undefined;

export interface Phase {
	db: Kysely<Database>;
	budget: BudgetFactory;
	steps: number;
}

/** A phase on `db`; with a ceiling, every step gets that many queries and a 1-byte budget. */
export function phase(db: Kysely<Database>, ceiling: number | null = null): Phase {
	if (ceiling === null) return { db, budget: () => undefined, steps: 0 };
	const { db: counted, faults } = withFaults(db);
	return { db: counted, budget: tinyBudget(faults, ceiling), steps: 0 };
}

function tinyBudget(faults: FaultPlugin, ceiling: number): BudgetFactory {
	return () => {
		const start = faults.executed;
		return new TransferStepBudget({
			queryCeiling: ceiling,
			bytes: 1,
			metrics: {
				get dbCount() {
					return faults.executed - start;
				},
			},
		});
	};
}

export async function exportOrigin(
	source: Phase,
	storage: MemoryStorage,
): Promise<ExportPackageReader> {
	const { operation } = await createExport({ db: source.db, createdBy: "origin-admin" });
	for (;;) {
		const result = await advanceExport({
			db: source.db,
			storage,
			operationId: operation.id,
			defaultLocale: "en",
			emdashVersion: "0.0.0-origin",
			budget: source.budget(),
			validatePackage: validateStagedPackageStep,
		});
		source.steps++;
		if (result.outcome === "advanced") {
			if (source.steps > MAX_STEPS)
				throw new Error(`export stalled: ${cursorOf(result.operation)}`);
			continue;
		}
		expect(result.operation.errorDetail).toBeNull();
		expect(result.outcome).toBe("complete");
		return openExportPackage({ db: source.db, storage, operation: result.operation });
	}
}

/**
 * Upload an export into a new import operation as a client does: the
 * manifest first, then index chunks, then every indexed file, each checked
 * against its declared size and digest.
 */
export async function uploadPackage(
	db: Kysely<Database>,
	storage: MemoryStorage,
	exported: ExportPackageReader,
): Promise<string> {
	const manifest = await exported.manifest();
	const repo = new TransferOperationRepository(db);
	const { operation } = await repo.create({
		kind: "import",
		createdBy: TARGET_BOB,
		packageDigest: await packageDigest(manifest),
		originSiteId: manifest.originSiteId,
	});
	const stage = new TransferStage(
		storage,
		stagingPrefix("import", operation.id, operation.stagingSecret),
	);
	const manifestBytes = await exported.stage.readBytes(MANIFEST_PATH, 8 * 1024 * 1024);
	await stage.putVerified(
		MANIFEST_PATH,
		manifestBytes,
		manifestBytes.byteLength,
		await sha256Hex(manifestBytes),
	);
	for (const ref of manifest.index) {
		await stage.putVerified(
			ref.path,
			await exported.stage.readBytes(ref.path, ref.bytes),
			ref.bytes,
			ref.sha256,
		);
	}

	const staged = new StagedPackageReader(stage);
	const entries = [];
	for await (const { entry } of staged.index()) entries.push(entry);
	const files = new TransferStagedFileRepository(db);
	await files.declareMany(
		operation.id,
		entries.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
	);
	for (const entry of entries) {
		const parsed = parsePackagePath(entry.path);
		const body =
			parsed?.type === "media"
				? await readStreamBytes(await exported.blob(parsed.sha256), entry.bytes)
				: await exported.stage.readBytes(entry.path, entry.bytes);
		await stage.putVerified(entry.path, body, entry.bytes, entry.sha256);
		expect(await files.markVerified(operation.id, entry)).toBe(true);
	}
	return operation.id;
}

export async function analyze(
	target: Phase,
	storage: MemoryStorage,
	operationId: string,
	targetContext: AnalysisTargetContext = TARGET_CONTEXT,
) {
	for (;;) {
		const result = await analyzeImportStep({
			db: target.db,
			storage,
			operationId,
			budget: target.budget() ?? new TransferStepBudget(),
			targetContext,
		});
		target.steps++;
		if (result.done) return result;
		if (target.steps > MAX_STEPS)
			throw new Error(`analysis stalled: ${cursorOf(result.operation)}`);
	}
}

export async function runImport(
	target: Phase,
	storage: MemoryStorage,
	operationId: string,
): Promise<AdvanceImportResult> {
	for (;;) {
		const result = await advanceImport({
			db: target.db,
			storage,
			operationId,
			verify: verifyImportStep,
			budget: target.budget(),
		});
		target.steps++;
		if (result.nextRequestInMs === null) return result;
		if (target.steps > MAX_STEPS) throw new Error(`import stalled: ${cursorOf(result.operation)}`);
	}
}

/** Finalize the analyzed plan with `principalMappings` and request execution. */
export async function executePlan(
	db: Kysely<Database>,
	storage: MemoryStorage,
	operationId: string,
	principalMappings: Record<string, string | null>,
) {
	const { plan, planDigest } = await finalizePlan({
		db,
		storage,
		operationId,
		decisions: { principalMappings },
	});
	await requestImportExecution({
		db,
		operationId,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- a finalized plan's package digest is a sha256 digest
		packageDigest: plan.packageDigest as Sha256Digest,
		planDigest,
	});
	return { plan, planDigest };
}

/**
 * Upload `exported` into `db`, analyze, plan with `principalMappings`
 * (default: every principal to its suggested user), and import.
 */
export async function importPackage(
	db: Kysely<Database>,
	storage: MemoryStorage,
	exported: ExportPackageReader,
	options: {
		principalMappings?: Record<string, string | null>;
		targetContext?: AnalysisTargetContext;
	} = {},
): Promise<AdvanceImportResult> {
	const operationId = await uploadPackage(db, storage, exported);
	const analysis = await analyze(phase(db), storage, operationId, options.targetContext);
	expect(analysis.plan?.blockers).toEqual([]);
	const mappings =
		options.principalMappings ??
		Object.fromEntries(
			(analysis.plan?.principals ?? []).map((principal) => [
				principal.id,
				principal.suggestedUserId ?? null,
			]),
		);
	await executePlan(db, storage, operationId, mappings);
	return runImport(phase(db), storage, operationId);
}

export async function seedTarget(
	db: Kysely<Database>,
	seed: SeedFile = defaultSeed,
): Promise<void> {
	await applySeed(db, seed, { includeContent: false, onConflict: "skip" });
	await db
		.insertInto("users")
		.values({
			id: TARGET_BOB,
			email: "Bob@Example.com",
			name: "Target Bob",
			avatar_url: null,
			role: 50,
			email_verified: 1,
			data: null,
		})
		.execute();
}
