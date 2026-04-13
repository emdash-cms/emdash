/**
 * Plugin Cron System
 *
 * Provides scheduled task execution for plugins:
 * - CronExecutor: claims overdue tasks, invokes per-plugin cron hook, updates next run.
 * - CronAccessImpl: per-plugin API for schedule/cancel/list.
 *
 */

import { Cron } from "croner";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../database/types.js";
import type { CronAccess, CronEvent, CronTaskInfo } from "./types.js";

/** Stale lock threshold in minutes */
const STALE_LOCK_MINUTES = 10;

/**
 * Callback to invoke a plugin's cron hook.
 * Provided by PluginManager so CronExecutor stays decoupled from the hook pipeline.
 */
export type InvokeCronHookFn = (pluginId: string, event: CronEvent) => Promise<void>;

/**
 * Callback to notify the scheduler that the next due time may have changed.
 */
export type RescheduleFn = () => void;

// ─── CronExecutor ──────────────────────────────────────────────────────────

/**
 * Executes overdue cron tasks.
 *
 * Called by platform-specific schedulers (NodeCronScheduler, EmDashScheduler DO,
 * PiggybackScheduler). Stateless — all state lives in the database.
 */
export class CronExecutor {
	constructor(
		private db: Kysely<Database>,
		private invokeCronHook: InvokeCronHookFn,
	) {}

	/**
	 * Process all overdue tasks.
	 *
	 * 1. Atomically claim tasks whose next_run_at <= now, status = idle, enabled = 1.
	 * 2. For each claimed task, invoke the plugin's cron hook.
	 * 3. On success: compute next_run_at and reset to idle, or delete one-shots.
	 * 4. On failure: reset to idle (retry on next tick).
	 */
	async tick(): Promise<number> {
		const now = new Date().toISOString();
		let processed = 0;

		// Claim overdue tasks atomically
		const claimed = await sql<{
			id: string;
			plugin_id: string;
			task_name: string;
			schedule: string;
			is_oneshot: number;
			data: string | null;
			next_run_at: string;
		}>`
			UPDATE _emdash_cron_tasks
			SET status = 'running', locked_at = ${now}
			WHERE id IN (
				SELECT id FROM _emdash_cron_tasks
				WHERE next_run_at <= ${now}
				  AND status = 'idle'
				  AND enabled = 1
				ORDER BY next_run_at ASC
				LIMIT 10
			)
			RETURNING id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at
		`.execute(this.db);

		for (const task of claimed.rows) {
			// Parse task data safely ��� malformed JSON must not crash the entire batch
			let parsedData: Record<string, unknown> | undefined;
			if (task.data) {
				try {
					parsedData = JSON.parse(task.data) as Record<string, unknown>;
				} catch {
					console.error(
						`[cron] Invalid JSON data for ${task.plugin_id}:${task.task_name}, skipping`,
					);
					await sql`
						UPDATE _emdash_cron_tasks
						SET status = 'idle', locked_at = NULL
						WHERE id = ${task.id}
					`.execute(this.db);
					continue;
				}
			}

			const event: CronEvent = {
				name: task.task_name,
				data: parsedData,
				scheduledAt: task.next_run_at,
			};

			let hookFailed = false;
			try {
				await this.invokeCronHook(task.plugin_id, event);
			} catch (error) {
				hookFailed = true;
				console.error(`[cron] Hook failed for ${task.plugin_id}:${task.task_name}:`, error);
			}

			if (task.is_oneshot) {
				if (hookFailed) {
					// Track retry count in the data JSON to enforce a limit.
					// Clamp to 0 to prevent plugins from pre-seeding a negative count.
					const raw = parsedData?._retryCount;
					const retryCount = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
					const MAX_ONESHOT_RETRIES = 5;

					if (retryCount >= MAX_ONESHOT_RETRIES) {
						console.error(
							`[cron] One-shot task ${task.plugin_id}:${task.task_name} exceeded ${MAX_ONESHOT_RETRIES} retries, removing`,
						);
						await sql`
							DELETE FROM _emdash_cron_tasks WHERE id = ${task.id}
						`.execute(this.db);
					} else {
						// Retry with exponential backoff: 1m, 2m, 4m, 8m, 16m
						const backoffMs = 60_000 * Math.pow(2, retryCount);
						const retryAt = new Date(Date.now() + backoffMs).toISOString();
						const updatedData = JSON.stringify({ ...parsedData, _retryCount: retryCount + 1 });
						await sql`
							UPDATE _emdash_cron_tasks
							SET status = 'idle', locked_at = NULL, next_run_at = ${retryAt}, data = ${updatedData}
							WHERE id = ${task.id}
						`.execute(this.db);
					}
				} else {
					// Success: delete the one-shot task
					await sql`
						DELETE FROM _emdash_cron_tasks WHERE id = ${task.id}
					`.execute(this.db);
				}
			} else {
				// Recurring: compute next run and reset
				const nextRun = nextCronTime(task.schedule);
				await sql`
					UPDATE _emdash_cron_tasks
					SET status = 'idle',
						locked_at = NULL,
						last_run_at = ${now},
						next_run_at = ${nextRun}
					WHERE id = ${task.id}
				`.execute(this.db);
			}

			processed++;
		}

		return processed;
	}

	/**
	 * Recover tasks stuck in 'running' for more than STALE_LOCK_MINUTES.
	 * These likely crashed mid-execution.
	 */
	async recoverStaleLocks(): Promise<number> {
		const cutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000).toISOString();

		const result = await sql`
			UPDATE _emdash_cron_tasks
			SET status = 'idle', locked_at = NULL
			WHERE status = 'running'
			  AND locked_at < ${cutoff}
		`.execute(this.db);

		return Number(result.numAffectedRows ?? 0);
	}

	/**
	 * Get the next due time across all enabled tasks.
	 * Returns null if no tasks are scheduled.
	 */
	async getNextDueTime(): Promise<string | null> {
		const result = await sql<{ next: string | null }>`
			SELECT MIN(next_run_at) as next
			FROM _emdash_cron_tasks
			WHERE status = 'idle' AND enabled = 1
		`.execute(this.db);

		return result.rows[0]?.next ?? null;
	}
}

// ─── CronAccessImpl ────────────────────────────────────────────────────────

/**
 * Per-plugin cron API implementation.
 * Scoped to a single plugin ID — plugins cannot see or modify other plugins' tasks.
 */
export class CronAccessImpl implements CronAccess {
	constructor(
		private db: Kysely<Database>,
		private pluginId: string,
		private reschedule: RescheduleFn,
	) {}

	async schedule(
		name: string,
		opts: { schedule: string; data?: Record<string, unknown> },
	): Promise<void> {
		validateTaskName(name);
		validateSchedule(opts.schedule);

		const oneshot = isOneShot(opts.schedule);
		const nextRun = oneshot ? opts.schedule : nextCronTime(opts.schedule);
		const dataJson = opts.data ? JSON.stringify(opts.data) : null;
		const id = ulid();

		// Upsert: if task already exists for this plugin+name, update it.
		// Guard: don't clobber a task that is currently executing.
		await sql`
			INSERT INTO _emdash_cron_tasks (id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at, status, enabled)
			VALUES (${id}, ${this.pluginId}, ${name}, ${opts.schedule}, ${oneshot ? 1 : 0}, ${dataJson}, ${nextRun}, 'idle', 1)
			ON CONFLICT (plugin_id, task_name) DO UPDATE SET
				schedule = ${opts.schedule},
				is_oneshot = ${oneshot ? 1 : 0},
				data = ${dataJson},
				next_run_at = ${nextRun},
				status = CASE WHEN _emdash_cron_tasks.status = 'running' THEN 'running' ELSE 'idle' END,
				locked_at = CASE WHEN _emdash_cron_tasks.status = 'running' THEN _emdash_cron_tasks.locked_at ELSE NULL END,
				enabled = 1
		`.execute(this.db);

		this.reschedule();
	}

	async cancel(name: string): Promise<void> {
		await sql`
			DELETE FROM _emdash_cron_tasks
			WHERE plugin_id = ${this.pluginId} AND task_name = ${name}
		`.execute(this.db);

		this.reschedule();
	}

	async list(): Promise<CronTaskInfo[]> {
		const rows = await sql<{
			task_name: string;
			schedule: string;
			next_run_at: string;
			last_run_at: string | null;
		}>`
			SELECT task_name, schedule, next_run_at, last_run_at
			FROM _emdash_cron_tasks
			WHERE plugin_id = ${this.pluginId} AND enabled = 1
			ORDER BY next_run_at ASC
		`.execute(this.db);

		return rows.rows.map((row) => ({
			name: row.task_name,
			schedule: row.schedule,
			nextRunAt: row.next_run_at,
			lastRunAt: row.last_run_at,
		}));
	}
}

// ─── Cron task lifecycle helpers ────────────────────────────────────────────

/**
 * Enable or disable all cron tasks for a plugin.
 * Called by admin disable/enable endpoints and PluginManager lifecycle.
 * Gracefully handles the cron table not existing yet (pre-migration).
 */
export async function setCronTasksEnabled(
	db: Kysely<Database>,
	pluginId: string,
	enabled: boolean,
): Promise<void> {
	try {
		await sql`
			UPDATE _emdash_cron_tasks
			SET enabled = ${enabled ? 1 : 0}
			WHERE plugin_id = ${pluginId}
		`.execute(db);
	} catch {
		// Cron table may not exist yet (pre-migration). Non-fatal.
	}
}

// ─── Cron utilities ────────────────────────────────────────────────────────

/**
 * Compute the next fire time for a cron expression.
 * Supports standard cron (5-field), extended (6-field with seconds), and
 * aliases like @daily, @weekly, @hourly, @monthly, @yearly.
 */
export function nextCronTime(expression: string): string {
	const job = new Cron(expression);
	const next = job.nextRun();
	if (!next) {
		throw new Error(`Invalid cron expression or no future run: "${expression}"`);
	}
	return next.toISOString();
}

/**
 * Check whether a string is a valid cron expression.
 */
function isCronExpression(schedule: string): boolean {
	try {
		// Cron constructor validates; we discard the instance immediately.
		const _cron = new Cron(schedule);
		void _cron;
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a schedule string is a one-shot (ISO 8601 datetime) rather than
 * a recurring cron expression.
 *
 * Tries to parse as a cron expression first. Only if that fails does it
 * attempt Date.parse. This avoids misclassifying cron range expressions
 * like "1-5 * * * *" which Date.parse accepts as valid dates.
 */
export function isOneShot(schedule: string): boolean {
	if (schedule.startsWith("@")) return false;
	if (isCronExpression(schedule)) return false;
	return !isNaN(Date.parse(schedule));
}

/** Max length for a task name */
const MAX_TASK_NAME_LENGTH = 128;
/** Task name pattern: alphanumeric, dashes, underscores */
const TASK_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Validate a cron task name.
 * Must be non-empty, ≤128 chars, alphanumeric with dashes/underscores.
 */
export function validateTaskName(name: string): void {
	if (!name || name.length > MAX_TASK_NAME_LENGTH) {
		throw new Error(
			`Invalid task name: must be 1-${MAX_TASK_NAME_LENGTH} characters, got ${name.length}`,
		);
	}
	if (!TASK_NAME_RE.test(name)) {
		throw new Error(
			`Invalid task name "${name}": must start with a letter and contain only letters, numbers, dashes, or underscores`,
		);
	}
}

/**
 * Validate a schedule string at registration time.
 * Must be a valid cron expression or a parseable ISO 8601 datetime.
 */
export function validateSchedule(schedule: string): void {
	if (!schedule || schedule.length > 256) {
		throw new Error(`Invalid schedule: must be 1-256 characters, got ${schedule.length}`);
	}

	// Try cron first
	if (isCronExpression(schedule)) return;

	const parsed = Date.parse(schedule);
	if (isNaN(parsed)) {
		throw new Error(
			`Invalid schedule "${schedule}": must be a valid cron expression or ISO 8601 datetime`,
		);
	}
}
