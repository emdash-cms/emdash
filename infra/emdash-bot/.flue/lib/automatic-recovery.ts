/** Automatic recoveries in a row before a failed issue waits for a maintainer. */
export const MAX_AUTOMATIC_RECOVERIES = 2;
const RECOVERY_DELAYS_MS = [2 * 60_000, 15 * 60_000] as const;

export interface AutomaticRecovery {
	/** `resume` continues a saved checkpoint; `retry` starts the failed mode again. */
	readonly action: "resume" | "retry";
	readonly at: number;
	readonly attempt: number;
	readonly dryRun?: boolean;
}

/**
 * Whether a failed run tries again on its own, and how. A verification
 * failure means the change didn't pass its own checks, so it waits for a
 * maintainer; the other stages are infrastructure the next attempt can get
 * past.
 */
export function planAutomaticRecovery(input: {
	failureStage: string | null;
	checkpoint: boolean;
	previousAttempts: number;
	now: number;
	dryRun?: boolean;
}): AutomaticRecovery | null {
	if (input.failureStage === "verification") return null;
	if (input.previousAttempts >= MAX_AUTOMATIC_RECOVERIES) return null;
	const attempt = input.previousAttempts + 1;
	const delay = RECOVERY_DELAYS_MS[Math.min(attempt, RECOVERY_DELAYS_MS.length) - 1];
	return {
		action: input.checkpoint ? "resume" : "retry",
		at: input.now + (delay ?? RECOVERY_DELAYS_MS[0]),
		attempt,
		...(input.dryRun ? { dryRun: true } : {}),
	};
}

export function automaticRecoveryNote(recovery: AutomaticRecovery | null, now: number): string {
	if (!recovery) return "A maintainer can continue with `@emdashbot retry`.";
	const minutes = Math.max(1, Math.round((recovery.at - now) / 60_000));
	const next = recovery.action === "resume" ? "continue from this checkpoint" : "try again";
	return `I'll ${next} automatically in about ${minutes} minute${minutes === 1 ? "" : "s"} (attempt ${recovery.attempt} of ${MAX_AUTOMATIC_RECOVERIES}).`;
}
