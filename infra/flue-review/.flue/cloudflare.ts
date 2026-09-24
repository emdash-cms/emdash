import { getRun } from "@flue/runtime";
import { DurableObject } from "cloudflare:workers";

import {
	completeReviewCheck,
	createReviewCheck,
	findReviewCheck,
	getPullRequestHeadSha,
	githubRateLimitGate,
	GitHubRateLimitError,
	readAppCreds,
	removePullRequestLabel,
	updateReviewCheck,
	type GitHubToken,
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
const SETUP_RETRY_BASE_MS = 30_000;
const SETUP_RETRY_MAX_MS = 60 * 60_000;
const SETUP_RETRY_LIMIT = 6;
const SETUP_RETRY_JITTER_RATIO = 0.2;
const WORKFLOW_RETRY_LIMIT = 2;
const WORKFLOW_STATUS_RETRY_MS = 60_000;
const WORKFLOW_ACTIVE_STALE_LIMIT_MS = 5 * 60_000;
const MANUAL_REVIEW_LABEL = "bot:review";

class TerminalConfigurationError extends Error {}

export function reviewSetupRetryDelay(
	error: unknown,
	retryCount: number,
	jitterUnit = Math.random(),
): number {
	if (error instanceof GitHubRateLimitError && error.hasRetryHint) return error.retryDelayMs;
	const base = Math.min(SETUP_RETRY_BASE_MS * 2 ** Math.max(0, retryCount - 1), SETUP_RETRY_MAX_MS);
	const jitter = base * SETUP_RETRY_JITTER_RATIO * Math.min(1, Math.max(0, jitterUnit));
	return Math.min(SETUP_RETRY_MAX_MS, Math.round(base + jitter));
}

export class ReviewWatchdog extends DurableObject<Env> {
	private async githubToken(consumer: string): Promise<GitHubToken> {
		const gate = githubRateLimitGate(this.env);
		const token = await gate.getInstallationToken();
		return { token, gate, consumer };
	}

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
			if ((await this.ctx.storage.getAlarm()) === null) {
				await this.ctx.storage.setAlarm(Math.max(Date.now(), existing.setupRetryAt ?? 0));
			}
			return { status: "busy" };
		}
		const reserved = {
			...attempt,
			setupLease,
			setupLeaseExpiresAt: Date.now() + REVIEW_SETUP_LEASE_MS,
		};
		await this.ctx.storage.transaction(async (transaction) => {
			await transaction.put(ATTEMPT_KEY, reserved);
			await transaction.setAlarm(Date.now());
		});
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
		const lastProgressAt = Date.now();
		await this.ctx.storage.put(ATTEMPT_KEY, {
			...attempt,
			admissionStartedAt: lastProgressAt,
			lastProgressAt,
			setupRetryAt: undefined,
		});
		await this.ctx.storage.setAlarm(lastProgressAt + reviewStaleAfter("admitted"));
		return true;
	}

	private async recordSetupTerminal(attempt: ReviewAttempt, summary: string): Promise<void> {
		const terminalAttempt = {
			...attempt,
			terminal: { conclusion: "failure", summary } satisfies ReviewTerminal,
		};
		await this.ctx.storage.put(ATTEMPT_KEY, terminalAttempt);
		try {
			await this.flushTerminal(terminalAttempt);
		} catch (error) {
			await this.scheduleTerminalRetry(terminalAttempt, error);
		}
	}

	private async scheduleSetupRetry(attempt: ReviewAttempt, error: unknown): Promise<void> {
		const setupRetryCount = (attempt.setupRetryCount ?? 0) + 1;
		const setupLastError = error instanceof Error ? error.message : String(error);
		if (setupRetryCount >= SETUP_RETRY_LIMIT) {
			console.error(
				JSON.stringify({
					message: "review setup retry exhausted",
					error: setupLastError,
					attemptId: attempt.attemptId,
					prNumber: attempt.prNumber,
					setupRetryCount,
				}),
			);
			await this.recordSetupTerminal(
				{ ...attempt, setupRetryCount, setupLastError },
				"GitHub remained unavailable while EmDashBot prepared the review. Remove and reapply the `bot:review` label to retry.",
			);
			return;
		}

		const delay = reviewSetupRetryDelay(error, setupRetryCount);
		const setupRetryAt = Date.now() + delay;
		await this.ctx.storage.put(ATTEMPT_KEY, {
			...attempt,
			setupRetryCount,
			setupRetryAt,
			setupLastError,
		});
		await this.ctx.storage.setAlarm(setupRetryAt);
		console.warn(
			JSON.stringify({
				message: "review setup retry scheduled",
				error: setupLastError,
				attemptId: attempt.attemptId,
				prNumber: attempt.prNumber,
				setupRetryCount,
				delay,
			}),
		);
	}

	private async setupAndAdmit(attempt: ReviewAttempt): Promise<void> {
		try {
			const creds = readAppCreds(this.env);
			if (!creds) throw new TerminalConfigurationError("GitHub App credentials are unavailable");
			if (!attempt.workflowInput) {
				throw new TerminalConfigurationError("Review attempt has no workflow input");
			}
			const token = await this.githubToken(`review-setup:${attempt.attemptId}`);
			let checkRunId = attempt.checkRunId;
			if (checkRunId === undefined) {
				checkRunId = await findReviewCheck(
					token,
					attempt.owner,
					attempt.repo,
					attempt.headSha,
					attempt.attemptId,
				);
			}
			if (checkRunId === undefined) {
				try {
					checkRunId = await createReviewCheck(token, attempt.owner, attempt.repo, {
						headSha: attempt.headSha,
						attemptId: attempt.attemptId,
						prNumber: attempt.prNumber,
					});
				} catch (createError) {
					try {
						checkRunId = await findReviewCheck(
							token,
							attempt.owner,
							attempt.repo,
							attempt.headSha,
							attempt.attemptId,
						);
					} catch (reconcileError) {
						throw reconcileError instanceof GitHubRateLimitError ? reconcileError : createError;
					}
					if (checkRunId === undefined) throw createError;
				}
			}

			const armedAttempt = { ...attempt, checkRunId, setupRetryAt: undefined };
			await this.arm(armedAttempt, attempt.setupLease ?? "");
			const latestHeadSha = await getPullRequestHeadSha(
				token,
				attempt.owner,
				attempt.repo,
				attempt.prNumber,
			);
			if (latestHeadSha !== attempt.headSha) {
				await this.recordSetupTerminal(
					armedAttempt,
					"This review request was superseded by a newer commit before the review started. Remove and reapply the `bot:review` label to review the current head.",
				);
				return;
			}
			if (!(await this.beginAdmission(attempt.attemptId, attempt.setupLease ?? ""))) return;

			const executionCtx = {
				waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
				passThroughOnException: () => undefined,
			};
			const response = await admitReviewWorkflow(
				{
					...attempt.workflowInput,
					attemptId: attempt.attemptId,
					expectedRunId: attempt.attemptId,
					deliveryId: attempt.deliveryId,
					checkRunId,
				},
				this.env,
				executionCtx,
			);
			if (!response.ok) throw new Error(`workflow admission returned ${response.status}`);
			const admission: { runId?: string } = await response
				.json<{ runId?: string }>()
				.catch(() => ({}));
			if (admission.runId) {
				await this.identify(attempt.attemptId, attempt.attemptId, admission.runId);
			}
			console.log(
				JSON.stringify({
					message: "review workflow admitted",
					attemptId: attempt.attemptId,
					runId: admission.runId,
					prNumber: attempt.prNumber,
					checkRunId,
				}),
			);
		} catch (error) {
			const current = await this.ctx.storage.get<ReviewAttempt>(ATTEMPT_KEY);
			if (!current || current.terminal || current.admissionStartedAt !== undefined) {
				if (current && !current.terminal) {
					await this.recordSetupTerminal(
						current,
						"The review could not be admitted. Remove and reapply the `bot:review` label to retry.",
					);
				}
				return;
			}
			if (error instanceof TerminalConfigurationError) {
				await this.recordSetupTerminal(current, error.message);
				return;
			}
			await this.scheduleSetupRetry(current, error);
		}
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
		try {
			const creds = readAppCreds(this.env);
			if (!creds) throw new TerminalConfigurationError("GitHub App credentials are unavailable");
			const token = await this.githubToken(`review-recovery:${attempt.attemptId}`);
			const currentHeadSha = await getPullRequestHeadSha(
				token,
				attempt.owner,
				attempt.repo,
				attempt.prNumber,
			);
			if (currentHeadSha !== attempt.headSha) {
				await this.recordSetupTerminal(
					attempt,
					"This review request was superseded by a newer commit before recovery. Remove and reapply the `bot:review` label to review the current head.",
				);
				return "pending";
			}
		} catch (error) {
			if (error instanceof TerminalConfigurationError) {
				await this.recordSetupTerminal(attempt, error.message);
				return "pending";
			}
			const recoveryHeadRetryCount = (attempt.recoveryHeadRetryCount ?? 0) + 1;
			if (recoveryHeadRetryCount >= SETUP_RETRY_LIMIT) {
				await this.recordSetupTerminal(
					{ ...attempt, recoveryHeadRetryCount },
					"GitHub remained unavailable while EmDashBot checked whether this review could be recovered. Remove and reapply the `bot:review` label to retry.",
				);
				return "pending";
			}
			const delay = reviewSetupRetryDelay(error, recoveryHeadRetryCount);
			await this.ctx.storage.put(ATTEMPT_KEY, { ...attempt, recoveryHeadRetryCount });
			await this.ctx.storage.setAlarm(Date.now() + delay);
			console.error(
				JSON.stringify({
					message: "review recovery head inspection failed",
					error: error instanceof Error ? error.message : String(error),
					attemptId: attempt.attemptId,
					runId: attempt.runId,
					recoveryHeadRetryCount,
					delay,
				}),
			);
			return "pending";
		}

		const lastProgressAt = Date.now();
		const retryRunId = `${attempt.attemptId}:retry:${workflowRetryCount}`;
		const retrying = {
			...attempt,
			runId: retryRunId,
			stage: "admitted" as const,
			lastProgressAt,
			workflowRetryCount,
			recoveryHeadRetryCount: undefined,
			workflowActiveStaleSince: undefined,
		};
		await this.ctx.storage.put(ATTEMPT_KEY, retrying);
		await this.ctx.storage.setAlarm(lastProgressAt + reviewStaleAfter("admitted"));
		try {
			const creds = readAppCreds(this.env);
			if (creds) {
				const token = await this.githubToken(`review-check-update:${attempt.attemptId}`);
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
		const creds = readAppCreds(this.env);
		if (!creds) throw new TerminalConfigurationError("GitHub App credentials are unavailable");
		const token = await this.githubToken(`review-terminal:${attempt.attemptId}`);
		if (attempt.checkRunId !== undefined) {
			await completeReviewCheck(token, attempt.owner, attempt.repo, attempt.checkRunId, {
				...attempt.terminal,
				prNumber: attempt.prNumber,
				runId: attempt.runId,
			});
		}
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
				console.info(
					JSON.stringify({
						message: "review watchdog self-cleanup completed",
						reason: "terminal-retention-expired",
						attemptId: attempt.attemptId,
						runId: attempt.runId,
						prNumber: attempt.prNumber,
						terminalReportedAt: attempt.terminalReportedAt ?? null,
						terminalAbandonedAt: attempt.terminalAbandonedAt ?? null,
					}),
				);
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
		if (
			attempt.admissionStartedAt === undefined &&
			(attempt.checkRunId === undefined || attempt.runId === attempt.attemptId)
		) {
			await this.setupAndAdmit(attempt);
			return;
		}
		if (!isReviewAttemptStale(attempt.lastProgressAt, Date.now(), attempt.stage)) {
			await this.ctx.storage.setAlarm(attempt.lastProgressAt + reviewStaleAfter(attempt.stage));
			return;
		}
		if (attempt.checkRunId === undefined) return;
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
