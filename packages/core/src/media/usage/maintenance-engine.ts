import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { getRequestContext } from "../../request-context.js";
import {
	continueMediaUsageActivation,
	MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION,
	MediaUsageActivationVersionMismatchError,
} from "./activation.js";
import {
	processDueMediaUsageCollectionDeletions,
	processMediaUsageCollectionDeletion,
} from "./collection-deletion-processor.js";
import { MediaUsageCollectionDeletionRepository } from "./collection-deletion.js";
import { processDueMediaUsageReconciliationDetailed } from "./reconciliation-processor.js";
import { MediaUsageReconciliationRepository } from "./reconciliation.js";
import { processDueMediaUsageWork } from "./work-processor.js";

type MediaUsageMaintenanceTaskClass = "entry_work" | "collection_deletion" | "reconciliation";

export type MediaUsageMaintenanceContinuation =
	| { kind: "none" }
	| { kind: "immediate" }
	| { kind: "delayed"; delaySeconds: 30 };

export interface MediaUsageMaintenanceStepResult {
	state: "inactive" | "idle" | "blocked" | "progress";
	continuation: MediaUsageMaintenanceContinuation;
}

export const MEDIA_USAGE_MAINTENANCE_LIMITS = Object.freeze({
	eventQueryCeiling: 900,
	maxStepQueries: 150,
});

const TASK_CLASSES: readonly MediaUsageMaintenanceTaskClass[] = [
	"collection_deletion",
	"entry_work",
	"reconciliation",
];

export async function runMediaUsageMaintenanceStep(
	db: Kysely<Database>,
): Promise<MediaUsageMaintenanceStepResult> {
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select(["state", "runtime_generation"])
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirst();
	if (
		activation?.state !== "active" ||
		activation.runtime_generation !== MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION
	) {
		return runActivationStep(db);
	}
	let blocked = false;
	let blockedReconciliation = false;
	let madeProgress = false;

	for (const taskClass of TASK_CLASSES) {
		const metrics = getRequestContext()?.metrics;
		if (metrics && !canStartMediaUsageMaintenanceStep(metrics)) {
			return madeProgress
				? {
						state: "progress",
						continuation: { kind: "immediate" },
					}
				: {
						state: "blocked",
						continuation: { kind: "immediate" },
					};
		}
		const outcome = await runTaskClass(db, taskClass);
		if (outcome === "inactive") return inactiveResult();
		if (outcome === "progress") madeProgress = true;
		if (outcome === "blocked") {
			blocked = true;
			if (taskClass === "reconciliation") blockedReconciliation = true;
		}
	}
	if (madeProgress) {
		return {
			state: "progress",
			continuation: { kind: "immediate" },
		};
	}

	if (
		blockedReconciliation &&
		(await new MediaUsageReconciliationRepository(db).wakeDrainedBarrierCandidate())
	) {
		return {
			state: "progress",
			continuation: { kind: "immediate" },
		};
	}

	if (blocked) {
		return {
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
		};
	}

	return {
		state: "idle",
		continuation: { kind: "none" },
	};
}

export type MediaUsageCollectionDeletionFinish =
	| { state: "finished" }
	| { state: "pending" }
	| { state: "failed"; collectionId: string };

/**
 * Finish the pending deletion of a collection slug within this request, so the
 * slug can be registered again. A call stops after about one maintenance step's
 * queries, so a create request never waits on a large cleanup.
 *
 * - `pending`: it can't finish now, because another request holds its lease,
 *   it is waiting out a retry, or this call's query window ran out. Progress
 *   is checkpointed, so a later call continues where this one stopped.
 * - `failed`: it ran out of attempts and stays until an operator retries it
 *   by the deleted collection's ID.
 */
export async function finishMediaUsageCollectionDeletion(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<MediaUsageCollectionDeletionFinish> {
	const repository = new MediaUsageCollectionDeletionRepository(db);
	const metrics = getRequestContext()?.metrics;
	const firstQuery = metrics?.dbCount ?? 0;
	for (;;) {
		const deletion = await repository.findBySlug(collectionSlug);
		if (!deletion) return { state: "finished" };
		if (deletion.state === "failed") {
			return { state: "failed", collectionId: deletion.collectionId };
		}
		if (
			metrics &&
			(metrics.dbCount - firstQuery >= MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries ||
				!canStartMediaUsageMaintenanceStep(metrics))
		) {
			return { state: "pending" };
		}
		const outcome = await processMediaUsageCollectionDeletion(db, deletion);
		if (outcome === "failed") return { state: "failed", collectionId: deletion.collectionId };
		if (outcome !== "progress" && outcome !== "finalized") return { state: "pending" };
	}
}

async function runActivationStep(db: Kysely<Database>): Promise<MediaUsageMaintenanceStepResult> {
	try {
		const result = await continueMediaUsageActivation(db);
		if (result.outcome === "activating" || result.outcome === "active") {
			return {
				state: "progress",
				continuation: { kind: "immediate" },
			};
		}
		if (result.outcome === "lease_active" || result.outcome === "conflict") {
			return {
				state: "blocked",
				continuation: { kind: "delayed", delaySeconds: 30 },
			};
		}
		return inactiveResult();
	} catch (error) {
		if (error instanceof MediaUsageActivationVersionMismatchError) return inactiveResult();
		throw error;
	}
}

async function runTaskClass(
	db: Kysely<Database>,
	taskClass: MediaUsageMaintenanceTaskClass,
): Promise<"inactive" | "idle" | "blocked" | "progress"> {
	if (taskClass === "entry_work") {
		const result = await processDueMediaUsageWork(db, {
			activationKnownActive: true,
		});
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}
	if (taskClass === "collection_deletion") {
		const result = await processDueMediaUsageCollectionDeletions(db);
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}

	const result = await processDueMediaUsageReconciliationDetailed(db, {
		activationKnownActive: true,
	});
	if (result.outcome === "inactive") return "inactive";
	if (result.consumedUnit) return "progress";
	return result.outcome === "claim_lost" || result.hasDeferredCandidate ? "blocked" : "idle";
}

function inactiveResult(): MediaUsageMaintenanceStepResult {
	return {
		state: "inactive",
		continuation: { kind: "none" },
	};
}

function canStartMediaUsageMaintenanceStep(metrics: { dbCount: number }): boolean {
	return (
		metrics.dbCount + MEDIA_USAGE_MAINTENANCE_LIMITS.maxStepQueries <=
		MEDIA_USAGE_MAINTENANCE_LIMITS.eventQueryCeiling
	);
}
