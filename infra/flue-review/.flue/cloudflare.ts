import { getRun } from "@flue/runtime";
import { DurableObject } from "cloudflare:workers";

import {
	completeReviewCheck,
	mintInstallationToken,
	readAppCreds,
	removePullRequestLabel,
	updateReviewCheck,
} from "./lib/github.js";
import {
	isReviewAttemptStale,
	reviewStaleAfter,
	REVIEW_SETUP_LEASE_MS,
	type ReviewAttempt,
	type ReviewStage,
	type ReviewTerminal,
} from "./lib/review-watchdog.js";
import { admitReviewWorkflow } from "./lib/workflow-admission.js";

const ATTEMPT_KEY = "attempt";
const TERMINAL_RETRY_BASE_MS = 60_000;
const TERMINAL_RETRY_MAX_MS = 60 * 60_000;
const TERMINAL_RETRY_LIMIT = 10;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const WORKFLOW_RETRY_LIMIT = 2;
const WORKFLOW_STATUS_RETRY_MS = 60_000;
const WORKFLOW_ACTIVE_STALE_LIMIT_MS = 5 * 60_000;
const MANUAL_REVIEW_LABEL = "bot:review";

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
		await this.ctx.storage.setAlarm(attempt.lastProgressAt + reviewStaleAfter(attempt.stage));
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
		await this.ctx.storage.setAlarm(attempt.lastProgressAt + reviewStaleAfter(attempt.stage));
	}

	async identify(attemptId: string, expectedRunId: string, runId: string): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (attempt?.attemptId === attemptId && !attempt.terminal && attempt.runId === runId) {
			return true;
		}
		if (
			!attempt ||
			attempt.attemptId !== attemptId ||
			attempt.runId !== expectedRunId ||
			attempt.terminal
		) {
			return false;
		}
		await this.ctx.storage.put(ATTEMPT_KEY, {
			...attempt,
			runId,
			workflowActiveStaleSince: undefined,
		});
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

	async heartbeat(attemptId: string, runId: string, stage: ReviewStage): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (
			!attempt ||
			attempt.attemptId !== attemptId ||
			attempt.runId !== runId ||
			attempt.terminal
		) {
			return false;
		}
		const lastProgressAt = Date.now();
		await this.ctx.storage.put(ATTEMPT_KEY, {
			...attempt,
			stage,
			lastProgressAt,
			workflowActiveStaleSince: undefined,
		});
		await this.ctx.storage.setAlarm(lastProgressAt + reviewStaleAfter(stage));
		return true;
	}

	async complete(attemptId: string): Promise<void> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (!attempt || attempt.attemptId !== attemptId) return;
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}

	async finish(attemptId: string, runId: string, terminal: ReviewTerminal): Promise<boolean> {
		const attempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (
			!attempt ||
			attempt.attemptId !== attemptId ||
			attempt.runId !== runId ||
			attempt.terminal
		) {
			return false;
		}
		const terminalAttempt = { ...attempt, terminal };
		await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
		try {
			await this.flushTerminal(terminalAttempt);
		} catch (error) {
			await this.scheduleTerminalRetry(terminalAttempt, error);
		}
		return true;
	}

	private async retryWorkflow(
		attempt: ReviewAttempt,
	): Promise<"admitted" | "pending" | "exhausted"> {
		const workflowRetryCount = (attempt.workflowRetryCount ?? 0) + 1;
		if (
			!attempt.workflowInput ||
			attempt.checkRunId === undefined ||
			workflowRetryCount > WORKFLOW_RETRY_LIMIT
		) {
			return "exhausted";
		}

		const lastProgressAt = Date.now();
		const retryRunId = `${attempt.attemptId}:retry:${workflowRetryCount}`;
		const retrying = {
			...attempt,
			runId: retryRunId,
			stage: "admitted" as const,
			lastProgressAt,
			workflowRetryCount,
			workflowActiveStaleSince: undefined,
		};
		await this.ctx.storage.put(ATTEMPT_KEY, retrying);
		await this.ctx.storage.setAlarm(lastProgressAt + reviewStaleAfter("admitted"));
		try {
			const creds = readAppCreds(this.env);
			if (creds) {
				const token = await mintInstallationToken(creds);
				await updateReviewCheck(token, attempt.owner, attempt.repo, attempt.checkRunId, {
					prNumber: attempt.prNumber,
					runId: retryRunId,
					stage: "hydrating",
					detail:
						"The previous review stopped reporting progress. EmDashBot is starting a replacement run.",
				});
			}
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "review recovery check update failed",
					error: error instanceof Error ? error.message : String(error),
					attemptId: attempt.attemptId,
					previousRunId: attempt.runId,
					workflowRetryCount,
				}),
			);
		}

		try {
			// Flue needs a fetch-style context to durably admit the replacement run.
			// DurableObjectState supplies the waitUntil primitive used by this path.
			const executionCtx = {
				waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
				passThroughOnException: () => undefined,
			};
			const response = await admitReviewWorkflow(
				{
					...attempt.workflowInput,
					attemptId: attempt.attemptId,
					expectedRunId: retryRunId,
					deliveryId: attempt.deliveryId,
					checkRunId: attempt.checkRunId,
				},
				this.env,
				executionCtx,
			);
			if (!response.ok) throw new Error(`workflow admission returned ${response.status}`);
			const admission: { runId?: string } = await response
				.json<{ runId?: string }>()
				.catch(() => ({}));
			if (admission.runId) {
				await this.identify(attempt.attemptId, retryRunId, admission.runId);
			}
			console.log(
				JSON.stringify({
					message: "stale review workflow re-admitted",
					attemptId: attempt.attemptId,
					previousRunId: attempt.runId,
					runId: admission.runId,
					workflowRetryCount,
				}),
			);
			return "admitted";
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "stale review workflow re-admission failed",
					error: error instanceof Error ? error.message : String(error),
					attemptId: attempt.attemptId,
					previousRunId: attempt.runId,
					workflowRetryCount,
				}),
			);
			return "pending";
		}
	}

	private async workflowStatus(
		attempt: ReviewAttempt,
	): Promise<"active" | "completed" | "recoverable" | "unavailable"> {
		try {
			const run = await getRun(attempt.runId);
			if (!run || run.status === "errored" || run.isError) return "recoverable";
			return run.status;
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "review workflow status inspection failed",
					error: error instanceof Error ? error.message : String(error),
					attemptId: attempt.attemptId,
					runId: attempt.runId,
				}),
			);
			await this.ctx.storage.setAlarm(Date.now() + WORKFLOW_STATUS_RETRY_MS);
			return "unavailable";
		}
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
		await removePullRequestLabel(
			token,
			attempt.owner,
			attempt.repo,
			attempt.prNumber,
			MANUAL_REVIEW_LABEL,
		);
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
		if (!isReviewAttemptStale(attempt.lastProgressAt, Date.now(), attempt.stage)) {
			await this.ctx.storage.setAlarm(attempt.lastProgressAt + reviewStaleAfter(attempt.stage));
			return;
		}
		if (attempt.checkRunId === undefined) {
			await this.ctx.storage.deleteAll();
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const workflowStatus = await this.workflowStatus(attempt);
		if (workflowStatus === "unavailable") return;
		const currentAttempt = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
		if (
			!currentAttempt ||
			currentAttempt.terminal ||
			currentAttempt.runId !== attempt.runId ||
			currentAttempt.stage !== attempt.stage ||
			currentAttempt.lastProgressAt !== attempt.lastProgressAt
		) {
			return;
		}
		if (workflowStatus === "active") {
			const now = Date.now();
			const workflowActiveStaleSince = currentAttempt.workflowActiveStaleSince ?? now;
			if (now - workflowActiveStaleSince < WORKFLOW_ACTIVE_STALE_LIMIT_MS) {
				await this.ctx.storage.put(ATTEMPT_KEY, {
					...currentAttempt,
					workflowActiveStaleSince,
				});
				await this.ctx.storage.setAlarm(now + WORKFLOW_STATUS_RETRY_MS);
				return;
			}
		}
		if (workflowStatus === "completed") {
			const terminalAttempt = {
				...currentAttempt,
				terminal: {
					conclusion: "success",
					summary: "The automated review completed successfully.",
				} satisfies ReviewTerminal,
			};
			await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
			try {
				await this.flushTerminal(terminalAttempt);
			} catch (error) {
				await this.scheduleTerminalRetry(terminalAttempt, error);
			}
			return;
		}
		if (workflowStatus === "recoverable") {
			const retryResult = await this.retryWorkflow(currentAttempt);
			if (retryResult !== "exhausted") return;
		}

		const terminal: ReviewTerminal = {
			conclusion: "timed_out",
			summary: `The review stopped reporting progress while in the \`${currentAttempt.stage}\` stage. Reapply the \`bot:review\` label to retry.`,
		};
		const terminalAttempt = { ...currentAttempt, terminal };
		await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
		console.error(
			JSON.stringify({
				message: "review watchdog timed out stale attempt",
				attemptId: currentAttempt.attemptId,
				runId: currentAttempt.runId,
				deliveryId: currentAttempt.deliveryId,
				prNumber: currentAttempt.prNumber,
				stage: currentAttempt.stage,
			}),
		);
		try {
			await this.flushTerminal(terminalAttempt);
		} catch (error) {
			await this.scheduleTerminalRetry(terminalAttempt, error);
		}
	}
}
