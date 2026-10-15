import { describe, expect, test } from "vitest";

import {
	automaticRecoveryNote,
	MAX_AUTOMATIC_RECOVERIES,
	planAutomaticRecovery,
} from "../../.flue/lib/automatic-recovery.js";

const now = 1_000_000;

describe("automatic recovery", () => {
	test("resumes a timed-out run from its checkpoint a couple of minutes later", () => {
		expect(
			planAutomaticRecovery({
				failureStage: "timeout",
				checkpoint: true,
				previousAttempts: 0,
				now,
			}),
		).toEqual({ action: "resume", at: now + 2 * 60_000, attempt: 1 });
	});

	test("retries a run that failed setting up its workspace", () => {
		expect(
			planAutomaticRecovery({
				failureStage: "workspace",
				checkpoint: false,
				previousAttempts: 0,
				now,
			}),
		).toMatchObject({ action: "retry", attempt: 1 });
	});

	test("retries a run that ended without a stage, such as a rejected dispatch", () => {
		expect(
			planAutomaticRecovery({ failureStage: null, checkpoint: false, previousAttempts: 0, now }),
		).toMatchObject({ action: "retry" });
	});

	test("leaves a change that failed its own verification to a maintainer", () => {
		expect(
			planAutomaticRecovery({
				failureStage: "verification",
				checkpoint: false,
				previousAttempts: 0,
				now,
			}),
		).toBeNull();
	});

	test("waits longer before the next attempt and stops at the limit", () => {
		expect(
			planAutomaticRecovery({
				failureStage: "timeout",
				checkpoint: true,
				previousAttempts: MAX_AUTOMATIC_RECOVERIES - 1,
				now,
			}),
		).toEqual({ action: "resume", at: now + 15 * 60_000, attempt: MAX_AUTOMATIC_RECOVERIES });
		expect(
			planAutomaticRecovery({
				failureStage: "timeout",
				checkpoint: true,
				previousAttempts: MAX_AUTOMATIC_RECOVERIES,
				now,
			}),
		).toBeNull();
	});

	test("keeps a dry run dry", () => {
		expect(
			planAutomaticRecovery({
				failureStage: "workspace",
				checkpoint: false,
				previousAttempts: 0,
				now,
				dryRun: true,
			}),
		).toMatchObject({ dryRun: true });
	});

	test("tells readers when the next attempt happens, or that a maintainer is needed", () => {
		expect(automaticRecoveryNote({ action: "resume", at: now + 2 * 60_000, attempt: 1 }, now)).toBe(
			`I'll continue from this checkpoint automatically in about 2 minutes (attempt 1 of ${MAX_AUTOMATIC_RECOVERIES}).`,
		);
		expect(automaticRecoveryNote({ action: "retry", at: now + 15 * 60_000, attempt: 2 }, now)).toBe(
			`I'll try again automatically in about 15 minutes (attempt 2 of ${MAX_AUTOMATIC_RECOVERIES}).`,
		);
		expect(automaticRecoveryNote(null, now)).toBe(
			"A maintainer can continue with `@emdashbot retry`.",
		);
	});
});
