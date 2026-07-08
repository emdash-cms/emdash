/**
 * Node.js cron scheduler — setTimeout-based.
 *
 * Queries the executor for the next due time and sets a timeout. Re-arms
 * after each tick and when reschedule() is called (new task scheduled or
 * cancelled).
 *
 * Suitable for single-process deployments (local dev, single-node).
 *
 */

import type { CronExecutor } from "../cron.js";
import type { CronScheduler, SystemCleanupFn } from "./types.js";

/** Minimum polling interval (ms) — prevents tight loops if next_run_at is in the past */
const MIN_INTERVAL_MS = 1000;

/**
 * Maximum polling interval (ms). Each wake runs the maintenance pass — stale
 * lock recovery *and* the scheduled-publishing sweep + system cleanup. The cap
 * is the worst-case latency for scheduled content when no plugin cron task is
 * due sooner (`getNextDueTime()` only knows about cron tasks, not content
 * `scheduled_at`). Held at 60s so Node publish latency matches the Cloudflare
 * Cron Trigger cadence (`* * * * *`) rather than lagging up to five minutes.
 */
const MAX_INTERVAL_MS = 60 * 1000;

export class NodeCronScheduler implements CronScheduler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private systemCleanup: SystemCleanupFn | null = null;

	constructor(private executor: CronExecutor) {}

	setSystemCleanup(fn: SystemCleanupFn): void {
		this.systemCleanup = fn;
	}

	start(): void {
		this.running = true;
		this.arm();
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	reschedule(): void {
		if (!this.running) return;
		// Clear existing timer and re-arm with fresh next due time
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.arm();
	}

	private arm(): void {
		if (!this.running) return;

		// Query the next due time, then schedule a wake-up
		void this.executor
			.getNextDueTime()
			.then((nextDue) => {
				if (!this.running) return undefined;

				let delayMs: number;
				if (nextDue) {
					const dueAt = new Date(nextDue).getTime();
					delayMs = Math.max(dueAt - Date.now(), MIN_INTERVAL_MS);
					delayMs = Math.min(delayMs, MAX_INTERVAL_MS);
				} else {
					// No tasks scheduled — poll at max interval for stale lock recovery
					delayMs = MAX_INTERVAL_MS;
				}

				this.timer = setTimeout(() => {
					if (!this.running) return;
					this.executeTick();
				}, delayMs);

				// Don't prevent process exit
				if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
					this.timer.unref();
				}

				return undefined;
			})
			.catch((error: unknown) => {
				console.error("[cron:node] Failed to get next due time:", error);
				// Retry after max interval
				if (this.running) {
					this.timer = setTimeout(() => this.arm(), MAX_INTERVAL_MS);
					if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
						this.timer.unref();
					}
				}
			});
	}

	private executeTick(): void {
		if (!this.running) return;

		// Run tick + stale lock recovery + system cleanup, then re-arm
		const tasks: Promise<unknown>[] = [this.executor.tick(), this.executor.recoverStaleLocks()];
		if (this.systemCleanup) {
			tasks.push(this.systemCleanup());
		}

		void Promise.allSettled(tasks)
			.then((results) => {
				for (const r of results) {
					if (r.status === "rejected") {
						console.error("[cron:node] Tick task failed:", r.reason);
					}
				}
				return undefined;
			})
			.finally(() => {
				if (this.running) {
					this.arm();
				}
			});
	}
}
