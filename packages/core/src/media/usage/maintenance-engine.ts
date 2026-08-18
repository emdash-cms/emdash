import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { processDueMediaUsageCollectionDeletions } from "./collection-deletion-processor.js";
import { processDueMediaUsageReconciliationDetailed } from "./reconciliation-processor.js";
import { processDueMediaUsageWork } from "./work-processor.js";

export type MediaUsageMaintenanceTaskClass =
	| "entry_work"
	| "collection_deletion"
	| "reconciliation";

export type MediaUsageMaintenanceContinuation =
	| { kind: "none" }
	| { kind: "immediate" }
	| { kind: "delayed"; delaySeconds: 30 };

export interface MediaUsageMaintenanceStepResult {
	state: "inactive" | "idle" | "blocked" | "progress";
	continuation: MediaUsageMaintenanceContinuation;
	taskClass: MediaUsageMaintenanceTaskClass | null;
	turn: number | null;
}

const TASK_CLASSES: readonly MediaUsageMaintenanceTaskClass[] = [
	"entry_work",
	"collection_deletion",
	"reconciliation",
];

export async function runMediaUsageMaintenanceStep(
	db: Kysely<Database>,
): Promise<MediaUsageMaintenanceStepResult> {
	const activation = await db
		.updateTable("_emdash_media_usage_activation")
		.set({
			media_usage_maintenance_turn: sql<number>`(media_usage_maintenance_turn + 1) % 3`,
		})
		.where("task_key", "=", "incremental_capture")
		.where("state", "=", "active")
		.returning("media_usage_maintenance_turn")
		.executeTakeFirst();
	if (!activation) return inactiveResult();

	const startingTurn = activation.media_usage_maintenance_turn;
	let firstBlocked: { taskClass: MediaUsageMaintenanceTaskClass; turn: number } | null = null;

	for (let offset = 0; offset < TASK_CLASSES.length; offset++) {
		const turn = (startingTurn + offset) % TASK_CLASSES.length;
		const taskClass = TASK_CLASSES[turn];
		const outcome = await runTaskClass(db, taskClass);
		if (outcome === "inactive") return inactiveResult();
		if (outcome === "progress") {
			return {
				state: "progress",
				continuation: { kind: "immediate" },
				taskClass,
				turn,
			};
		}
		if (outcome === "blocked" && !firstBlocked) firstBlocked = { taskClass, turn };
	}

	if (firstBlocked) {
		return {
			state: "blocked",
			continuation: { kind: "delayed", delaySeconds: 30 },
			...firstBlocked,
		};
	}

	return {
		state: "idle",
		continuation: { kind: "none" },
		taskClass: TASK_CLASSES[startingTurn],
		turn: startingTurn,
	};
}

async function runTaskClass(
	db: Kysely<Database>,
	taskClass: MediaUsageMaintenanceTaskClass,
): Promise<"inactive" | "idle" | "blocked" | "progress"> {
	if (taskClass === "entry_work") {
		const result = await processDueMediaUsageWork(db);
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}
	if (taskClass === "collection_deletion") {
		const result = await processDueMediaUsageCollectionDeletions(db);
		if (result.claimedCount > 0) return "progress";
		return result.candidateCount > 0 ? "blocked" : "idle";
	}

	const result = await processDueMediaUsageReconciliationDetailed(db);
	if (result.outcome === "inactive") return "inactive";
	if (result.consumedUnit) return "progress";
	return result.outcome === "claim_lost" ? "blocked" : "idle";
}

function inactiveResult(): MediaUsageMaintenanceStepResult {
	return {
		state: "inactive",
		continuation: { kind: "none" },
		taskClass: null,
		turn: null,
	};
}
