/**
 * Platform-specific cron scheduler interface.
 *
 * Schedulers are responsible for calling CronExecutor.tick() at the right
 * time. The executor handles all business logic; the scheduler only manages
 * timing.
 *
 * Implementations receive the CronExecutor via constructor.
 *
 */

export interface CronScheduler {
	/** Start the scheduler. */
	start(): void | Promise<void>;
	/** Stop the scheduler and clean up timers/alarms. */
	stop(): void | Promise<void>;
	/** Signal that the next due time may have changed (task added/cancelled). */
	reschedule(): void;
	/** Register a system cleanup function to run alongside each tick. */
	setSystemCleanup(fn: SystemCleanupFn): void;
}

/**
 * System cleanup callback invoked alongside each scheduler tick.
 * Fire-and-forget -- failures are logged internally and never propagate.
 */
export type SystemCleanupFn = () => Promise<void>;
