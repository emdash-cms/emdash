import type { Kysely } from "kysely";

import type { Database } from "../../../../src/database/types.js";
import type { Storage } from "../../../../src/storage/types.js";
import {
	validateStagedPackageStep,
	type ValidationStepResult,
} from "../../../../src/transfer/analyze/validate.js";
import {
	advanceExport,
	createExport,
	openExportPackage,
	type AdvanceExportInput,
	type AdvanceExportResult,
	type ExportOptions,
	type ExportPackageReader,
} from "../../../../src/transfer/export/exporter.js";
import { RECORD_KINDS, type SitePackageRecord } from "../../../../src/transfer/format/kinds.js";
import { MANIFEST_PATH } from "../../../../src/transfer/format/paths.js";
import type { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { readStreamBytes } from "../../../../src/transfer/staging/stage.js";

export interface ExportRun {
	result: AdvanceExportResult;
	steps: number;
	reader: ExportPackageReader;
	/** The package validator's final result, unless `extra` replaced the validator. */
	validation: ValidationStepResult | null;
}

export async function runExport(
	db: Kysely<Database>,
	storage: Storage,
	options: {
		exportOptions?: ExportOptions;
		budget?: () => TransferStepBudget;
		beforeStep?: (step: number) => Promise<void> | void;
		extra?: Partial<AdvanceExportInput>;
		maxSteps?: number;
	} = {},
): Promise<ExportRun> {
	const { operation } = await createExport({
		db,
		createdBy: "exporter",
		options: options.exportOptions,
	});
	return driveExport(db, storage, operation.id, options);
}

export async function driveExport(
	db: Kysely<Database>,
	storage: Storage,
	operationId: string,
	options: {
		budget?: () => TransferStepBudget;
		beforeStep?: (step: number) => Promise<void> | void;
		extra?: Partial<AdvanceExportInput>;
		maxSteps?: number;
	} = {},
): Promise<ExportRun> {
	let steps = 0;
	let result: AdvanceExportResult;
	let validation: ValidationStepResult | null = null;
	do {
		await options.beforeStep?.(steps);
		result = await advanceExport({
			db,
			storage,
			operationId,
			defaultLocale: "en",
			emdashVersion: "0.0.0-test",
			budget: options.budget?.(),
			validatePackage: async (input) => {
				validation = await validateStagedPackageStep(input);
				return validation;
			},
			...options.extra,
		});
		steps++;
		if (steps > (options.maxSteps ?? 10_000)) throw new Error("export did not finish");
	} while (result.outcome === "advanced");
	return {
		result,
		steps,
		reader: openExportPackage({ db, storage, operation: result.operation }),
		validation,
	};
}

/** Every file of a package by path (manifest, index, records, blobs). */
export async function packageFiles(reader: ExportPackageReader): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	const manifest = await reader.manifest();
	files.set(MANIFEST_PATH, await reader.stage.readBytes(MANIFEST_PATH, 8 * 1024 * 1024));
	for (const ref of manifest.index) {
		files.set(ref.path, await reader.stage.readBytes(ref.path, ref.bytes));
	}
	for await (const { entry } of reader.index()) {
		if (entry.path.startsWith("media/")) {
			const sha = entry.path.slice("media/".length);
			files.set(entry.path, await readStreamBytes(await reader.blob(sha), entry.bytes));
		} else {
			files.set(entry.path, await reader.stage.readBytes(entry.path, entry.bytes));
		}
	}
	return files;
}

export async function packageRecords(
	reader: ExportPackageReader,
): Promise<Map<string, SitePackageRecord[]>> {
	const records = new Map<string, SitePackageRecord[]>();
	for (const kind of RECORD_KINDS) {
		const list: SitePackageRecord[] = [];
		for await (const { record } of reader.records(kind)) list.push(record);
		records.set(kind, list);
	}
	return records;
}
