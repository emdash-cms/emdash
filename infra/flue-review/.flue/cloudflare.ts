import { DurableObject } from "cloudflare:workers";

import { completeReviewCheck, mintInstallationToken, readAppCreds } from "./lib/github.js";
import {
	isReviewAttemptStale,
	REVIEW_SETUP_LEASE_MS,
	REVIEW_STALE_AFTER_MS,
	type ReviewAttempt,
	type ReviewStage,
	type ReviewTerminal,
} from "./lib/review-watchdog.js";

const ATTEMPT_KEY = "attempt";
const TERMINAL_RETRY_BASE_MS = 60_000;
const TERMINAL_RETRY_MAX_MS = 60 * 60_000;
const TERMINAL_RETRY_LIMIT = 10;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

class TerminalConfigurationError extends Error {}

export class ReviewWatchdog extends DurableObject<Env> {
	async reserve(
		attempt: ReviewAttempt,
		setupLease: string,
	): Promise<
		{ status: "acquired"; attempt: ReviewAttempt } | { status: "busy" } | { status: "complete" }
	> {
		const existing = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (existing) {
			if (existing.terminal || existing.admissionStartedAt !== undefined) {
				return { status: "complete" };
			}
			if (
				existing.setupLease &&
				existing.setupLease !== setupLease &&
				(existing.setupLeaseExpiresAt ?? 0) > Date.now()
			) {
				return { status: "busy" };
			}
			const resumed = {
				...existing,
				setupLease,
				setupLeaseExpiresAt: Date.now() + REVIEW_SETUP_LEASE_MS,
			};
			await this.ctx.storage.put(ATTEMPT_KEY, resumed);
			return { status: "acquired", attempt: resumed };
		}
		const reserved = {
			...attempt,
			setupLease,
			setupLeaseExpiresAt: Date.now() + REVIEW_SETUP_LEASE_MS,
		};
		await this.ctx.storage.put(ATTEMPT_KEY, reserved);
		await this.ctx.storage.setAlarm(attempt.lastProgressAt + REVIEW_STALE_AFTER_MS);
		return { status: "acquired", attempt: reserved };
	}

	async arm(attempt: ReviewAttempt, setupLease: string): Promise<void> {
		const reserved = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (
			!reserved ||
			reserved.attemptId !== attempt.attemptId ||
			reserved.setupLease !== setupLease ||
			reserved.admissionStartedAt !== undefined
		) {
			throw new Error("Review attempt was not reserved");
		}
		await this.ctx.storage.put(ATTEMPT_KEY, { ...reserved, ...attempt });
		await this.ctx.storage.setAlarm(attempt.lastProgressAt + REVIEW_STALE_AFTER_MS);
	}

	async identify(attemptId: string, runId: string): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt || attempt.attemptId !== attemptId || attempt.terminal) return false;
		await this.ctx.storage.put(ATTEMPT_KEY, { ...attempt, runId });
		return true;
	}

	async beginAdmission(attemptId: string, setupLease: string): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (
			!attempt ||
			attempt.attemptId !== attemptId ||
			attempt.setupLease !== setupLease ||
			attempt.terminal ||
			attempt.admissionStartedAt !== undefined
		) {
			return false;
		}
		await this.ctx.storage.put(ATTEMPT_KEY, { ...attempt, admissionStartedAt: Date.now() });
		return true;
	}

	async heartbeat(attemptId: string, stage: ReviewStage): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt || attempt.attemptId !== attemptId || attempt.terminal) return false;
		const lastProgressAt = Date.now();
		await this.ctx.storage.put(ATTEMPT_KEY, { ...attempt, stage, lastProgressAt });
		await this.ctx.storage.setAlarm(lastProgressAt + REVIEW_STALE_AFTER_MS);
		return true;
	}

	async complete(attemptId: string): Promise<void> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt || attempt.attemptId !== attemptId) return;
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}

	async finish(attemptId: string, terminal: ReviewTerminal): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt || attempt.attemptId !== attemptId || attempt.terminal) return false;
		const terminalAttempt = { ...attempt, terminal };
		await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
		try {
			await this.flushTerminal(terminalAttempt);
		} catch (error) {
			await this.scheduleTerminalRetry(terminalAttempt, error);
		}
		return true;
	}

	private async flushTerminal(
		attempt: ReviewAttempt & { terminal: ReviewTerminal },
	): Promise<void> {
		if (attempt.checkRunId === undefined) {
			throw new TerminalConfigurationError("Review attempt has no GitHub check run");
		}
		const creds = readAppCreds(this.env);
		if (!creds) throw new TerminalConfigurationError("GitHub App credentials are unavailable");
		const token = await mintInstallationToken(creds);
		await completeReviewCheck(token, attempt.owner, attempt.repo, attempt.checkRunId, {
			...attempt.terminal,
			prNumber: attempt.prNumber,
			runId: attempt.runId,
		});
		await this.ctx.storage.put(ATTEMPT_KEY, {
			...attempt,
			terminalReportedAt: Date.now(),
		});
		await this.ctx.storage.setAlarm(Date.now() + TERMINAL_RETENTION_MS);
	}

	private async scheduleTerminalRetry(
		attempt: ReviewAttempt & { terminal: ReviewTerminal },
		error: unknown,
	): Promise<void> {
		const retryCount = (attempt.terminalRetryCount ?? 0) + 1;
		const abandoned =
			error instanceof TerminalConfigurationError || retryCount >= TERMINAL_RETRY_LIMIT;
		if (abandoned) {
			const terminalAbandonedAt = Date.now();
			await this.ctx.storage.put(ATTEMPT_KEY, {
				...attempt,
				terminalRetryCount: retryCount,
				terminalAbandonedAt,
			});
			await this.ctx.storage.setAlarm(terminalAbandonedAt + TERMINAL_RETENTION_MS);
			console.error(
				JSON.stringify({
					message: "review terminal reporting abandoned",
					error: error instanceof Error ? error.message : String(error),
					attemptId: attempt.attemptId,
					runId: attempt.runId,
					retryCount,
				}),
			);
			return;
		}

		const delay = Math.min(TERMINAL_RETRY_BASE_MS * 2 ** (retryCount - 1), TERMINAL_RETRY_MAX_MS);
		await this.ctx.storage.put(ATTEMPT_KEY, { ...attempt, terminalRetryCount: retryCount });
		await this.ctx.storage.setAlarm(Date.now() + delay);
		console.error(
			JSON.stringify({
				message: "review terminal reporting retry scheduled",
				error: error instanceof Error ? error.message : String(error),
				attemptId: attempt.attemptId,
				runId: attempt.runId,
				retryCount,
				delay,
			}),
		);
	}

	override async alarm(): Promise<void> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt) return;
		const retainedAt = attempt.terminalReportedAt ?? attempt.terminalAbandonedAt;
		if (retainedAt !== undefined) {
			const cleanupAt = retainedAt + TERMINAL_RETENTION_MS;
			if (Date.now() >= cleanupAt) {
				await this.ctx.storage.deleteAll();
				await this.ctx.storage.deleteAlarm();
			} else {
				await this.ctx.storage.setAlarm(cleanupAt);
			}
			return;
		}
		if (attempt.terminal) {
			const terminalAttempt = { ...attempt, terminal: attempt.terminal };
			try {
				await this.flushTerminal(terminalAttempt);
			} catch (error) {
				await this.scheduleTerminalRetry(terminalAttempt, error);
			}
			return;
		}
		if (!isReviewAttemptStale(attempt.lastProgressAt)) {
			await this.ctx.storage.setAlarm(attempt.lastProgressAt + REVIEW_STALE_AFTER_MS);
			return;
		}
		if (attempt.checkRunId === undefined) {
			await this.ctx.storage.deleteAll();
			await this.ctx.storage.deleteAlarm();
			return;
		}

		const terminal: ReviewTerminal = {
			conclusion: "timed_out",
			summary: `The review stopped reporting progress while in the \`${attempt.stage}\` stage. Reapply the \`bot:review\` label to retry.`,
		};
		const terminalAttempt = { ...attempt, terminal };
		await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
		console.error(
			JSON.stringify({
				message: "review watchdog timed out stale attempt",
				attemptId: attempt.attemptId,
				runId: attempt.runId,
				deliveryId: attempt.deliveryId,
				prNumber: attempt.prNumber,
				stage: attempt.stage,
			}),
		);
		try {
			await this.flushTerminal(terminalAttempt);
		} catch (error) {
			await this.scheduleTerminalRetry(terminalAttempt, error);
		}
	}
}
