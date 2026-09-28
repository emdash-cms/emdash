import type { Kysely } from "kysely";

import { OptionsRepository } from "./database/repositories/options.js";
import type { Database } from "./database/types.js";

export const SCHEDULER_HEARTBEAT_OPTION = "system:scheduler:last_completed_at";
export const SCHEDULER_STALE_AFTER_MS = 5 * 60 * 1000;

export interface SchedulerHealth {
	status: "healthy" | "stale" | "unknown";
	lastCompletedAt: string | null;
}

export async function recordSchedulerHeartbeat(
	db: Kysely<Database>,
	completedAt = new Date(),
): Promise<void> {
	await new OptionsRepository(db).set(SCHEDULER_HEARTBEAT_OPTION, completedAt.toISOString());
}

export async function recordSchedulerHeartbeatSafely(
	db: Kysely<Database>,
	completedAt = new Date(),
): Promise<void> {
	try {
		await recordSchedulerHeartbeat(db, completedAt);
	} catch (error) {
		console.error("[scheduler] Failed to record heartbeat:", error);
	}
}

export async function getSchedulerHealth(
	db: Kysely<Database>,
	now = new Date(),
): Promise<SchedulerHealth> {
	const lastCompletedAt = await new OptionsRepository(db).get<string>(SCHEDULER_HEARTBEAT_OPTION);
	const lastCompletedAtMs = lastCompletedAt ? Date.parse(lastCompletedAt) : Number.NaN;
	if (!lastCompletedAt || Number.isNaN(lastCompletedAtMs)) {
		return { status: "unknown", lastCompletedAt: null };
	}

	return {
		status: now.getTime() - lastCompletedAtMs > SCHEDULER_STALE_AFTER_MS ? "stale" : "healthy",
		lastCompletedAt,
	};
}
