/**
 * Bounded collection of transfer staging areas, run from system cleanup.
 *
 * Each tick expires overdue operations and approval grants, then collects
 * the staging area of a few finished operations: staged objects (package
 * files, the plan, and analysis state) first, then child rows, then the
 * operation is marked collected. Work stops when the tick's budgets run out
 * and resumes on the next tick. Operation rows, and the receipts they carry,
 * are kept.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import type { Storage } from "../storage/types.js";
import { TransferApprovalRepository } from "./ops/approvals.js";
import { TransferOperationRepository } from "./ops/operations.js";
import { stagingPrefix } from "./staging/keys.js";
import { TransferStage } from "./staging/stage.js";

/** How long a finished import's staging is kept after its last state change. */
export const IMPORT_STAGING_RETENTION_SECONDS = 24 * 60 * 60;

export interface TransferStagingCollectionOptions {
	/** Operations to expire, and to collect, per tick. */
	operations?: number;
	/** Staged objects deleted per tick, across all operations. */
	objects?: number;
	/** `deleteChildRows` calls per tick, across all operations. */
	rowBatches?: number;
}

export interface TransferStagingCollectionResult {
	expired: number;
	collected: number;
	objectsDeleted: number;
	rowsDeleted: number;
}

const OBJECT_BATCH = 100;
const ROW_BATCH = 500;

export async function collectTransferStaging(
	db: Kysely<Database>,
	storage: Storage,
	options: TransferStagingCollectionOptions = {},
): Promise<TransferStagingCollectionResult> {
	const operationLimit = options.operations ?? 5;
	let objectBudget = options.objects ?? 1000;
	let rowBatchBudget = options.rowBatches ?? 20;
	const result: TransferStagingCollectionResult = {
		expired: 0,
		collected: 0,
		objectsDeleted: 0,
		rowsDeleted: 0,
	};

	const operations = new TransferOperationRepository(db);
	result.expired = (await operations.expireDue(operationLimit)).length;
	await new TransferApprovalRepository(db).expireDue();

	const pending = await operations.listUncollected(operationLimit, {
		importRetentionSeconds: IMPORT_STAGING_RETENTION_SECONDS,
	});
	for (const operation of pending) {
		if (objectBudget <= 0 || rowBatchBudget <= 0) break;
		try {
			const stage = new TransferStage(
				storage,
				stagingPrefix(operation.kind, operation.id, operation.stagingSecret),
			);
			let objectsDone = false;
			while (objectBudget > 0) {
				const deleted = await stage.deleteSome(Math.min(OBJECT_BATCH, objectBudget));
				objectBudget -= deleted;
				result.objectsDeleted += deleted;
				if (deleted === 0) {
					objectsDone = true;
					break;
				}
			}
			if (!objectsDone) break;

			let rowsDone = false;
			while (rowBatchBudget > 0) {
				rowBatchBudget--;
				const deleted = await operations.deleteChildRows(operation.id, ROW_BATCH);
				result.rowsDeleted += deleted;
				if (deleted === 0) {
					rowsDone = true;
					break;
				}
			}
			if (!rowsDone) break;

			await operations.markCollected(operation.id);
			result.collected++;
		} catch (error) {
			console.error(`[transfer] Failed to collect staging for operation ${operation.id}:`, error);
		}
	}
	return result;
}
