import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "ulidx";

import { formatSubmissionText, formatWebhookPayload } from "./format.js";
import type {
	DeliveryAggregateStatus,
	DeliveryDestination,
	DeliveryHeartbeat,
	FormDefinition,
	Submission,
	SubmissionFile,
	SubmissionDelivery,
} from "./types.js";
import { getFormFields } from "./types.js";

const DELIVERY_VERSION = 1;
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 500;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const DELIVERY_BATCH_SIZE = 100;
export const DELIVERY_CRON_NAME = "delivery";
export const DELIVERY_CRON_SCHEDULE = "* * * * *";
export const DELIVERY_HEARTBEAT_KEY = "state:deliveryHeartbeat";
export const DELIVERY_HEARTBEAT_STALE_MS = 3 * 60 * 1000;

interface DeliveryProcessorOptions {
	now?: Date;
}

function submissions(ctx: PluginContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

function destinationBase(id: string, now: string) {
	return {
		id,
		status: "pending" as const,
		attempts: 0,
		createdAt: now,
		updatedAt: now,
		nextAttemptAt: now,
		claimedAt: null,
		claimToken: null,
		attemptedAt: null,
		deliveredAt: null,
		terminalAt: null,
		lastError: null,
	};
}

export function createSubmissionDelivery(params: {
	form: FormDefinition;
	submissionId: string;
	receiptId: string;
	data: Record<string, unknown>;
	files?: SubmissionFile[];
	createdAt: string;
}): SubmissionDelivery {
	const { form, submissionId, receiptId, data, files, createdAt } = params;
	const destinations: DeliveryDestination[] = [];
	const notificationText = formatSubmissionText(form, data, files);

	if (!form.settings.digestEnabled) {
		for (const [index, email] of form.settings.notifyEmails.entries()) {
			destinations.push({
				...destinationBase(`${receiptId}:notification-email:${index}`, createdAt),
				type: "notification-email",
				to: email,
				subject: `New submission: ${form.name}`,
				text: notificationText,
			});
		}
	}

	if (form.settings.autoresponder) {
		const emailField = getFormFields(form).find((field) => field.type === "email");
		const submitterEmail = emailField ? data[emailField.name] : null;
		if (typeof submitterEmail === "string" && submitterEmail) {
			destinations.push({
				...destinationBase(`${receiptId}:autoresponder-email`, createdAt),
				type: "autoresponder-email",
				to: submitterEmail,
				subject: form.settings.autoresponder.subject,
				text: form.settings.autoresponder.body,
			});
		}
	}

	if (form.settings.webhookUrl) {
		destinations.push({
			...destinationBase(`${receiptId}:webhook`, createdAt),
			type: "webhook",
			url: form.settings.webhookUrl,
			body: {
				...formatWebhookPayload(form, submissionId, data, files),
				receiptId,
			},
		});
	}

	return {
		version: DELIVERY_VERSION,
		receiptId,
		destinations,
	};
}

export function summarizeDelivery(delivery: SubmissionDelivery): {
	status: DeliveryAggregateStatus;
	nextAttemptAt: string | null;
} {
	if (delivery.destinations.length === 0) {
		return { status: "delivered", nextAttemptAt: null };
	}

	const active = delivery.destinations.filter(
		(destination) => destination.status !== "delivered" && destination.status !== "terminal",
	);
	if (active.length === 0) {
		return {
			status: delivery.destinations.some((destination) => destination.status === "terminal")
				? "terminal"
				: "delivered",
			nextAttemptAt: null,
		};
	}

	const nextAttemptAt =
		active
			.map((destination) => destination.nextAttemptAt)
			.filter((value): value is string => value !== null)
			.toSorted()[0] ?? null;

	const status: DeliveryAggregateStatus = active.some(
		(destination) => destination.status === "processing",
	)
		? "processing"
		: active.some((destination) => destination.status === "retrying")
			? "retrying"
			: "pending";

	return { status, nextAttemptAt };
}

function withDeliverySummary(submission: Submission): Submission {
	if (!submission.delivery) return submission;
	const summary = summarizeDelivery(submission.delivery);
	return {
		...submission,
		deliveryStatus: summary.status,
		deliveryNextAttemptAt: summary.nextAttemptAt,
	};
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replaceAll(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

async function recordHeartbeat(
	ctx: PluginContext,
	status: DeliveryHeartbeat["status"],
	completedAt: string,
	error: unknown | null,
): Promise<void> {
	const previous = await ctx.kv.get<DeliveryHeartbeat>(DELIVERY_HEARTBEAT_KEY);
	const heartbeat: DeliveryHeartbeat = {
		version: 1,
		status,
		completedAt,
		lastSuccessAt:
			status === "success" ? completedAt : previous?.version === 1 ? previous.lastSuccessAt : null,
		error: error === null ? null : boundedError(error),
	};
	await ctx.kv.set(DELIVERY_HEARTBEAT_KEY, heartbeat);
}

function nextBackoff(attempts: number): number {
	return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function findDestination(
	submission: Submission,
	destinationId: string,
): DeliveryDestination | undefined {
	return submission.delivery?.destinations.find((destination) => destination.id === destinationId);
}

async function claimDestination(
	submissionId: string,
	destinationId: string,
	ctx: PluginContext,
	now: Date,
): Promise<{ submission: Submission; destination: DeliveryDestination } | null> {
	const collection = submissions(ctx);
	const current = await collection.get(submissionId);
	const destination = current ? findDestination(current, destinationId) : undefined;
	if (
		!current?.delivery ||
		!destination ||
		destination.status === "delivered" ||
		destination.status === "terminal" ||
		!destination.nextAttemptAt ||
		destination.nextAttemptAt > now.toISOString()
	) {
		return null;
	}

	const claimToken = ulid();
	const claimedAt = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
	const claimed: DeliveryDestination = {
		...destination,
		status: "processing",
		attempts: destination.attempts + 1,
		updatedAt: claimedAt,
		nextAttemptAt: leaseExpiresAt,
		claimedAt,
		claimToken,
		attemptedAt: claimedAt,
	};
	const updated = withDeliverySummary({
		...current,
		delivery: {
			...current.delivery,
			destinations: current.delivery.destinations.map((item) =>
				item.id === destinationId ? claimed : item,
			),
		},
	});

	await collection.put(submissionId, updated);

	// Plugin storage has no compare-and-set operation. Read-back verification plus the
	// lease is the strongest cross-isolate claim available; concurrent isolates can
	// still both deliver if their writes and reads interleave before either observes
	// the other's token. Provider-side idempotency is therefore required for strict
	// exactly-once effects.
	const verified = await collection.get(submissionId);
	const verifiedDestination = verified ? findDestination(verified, destinationId) : undefined;
	if (!verified || verifiedDestination?.claimToken !== claimToken) {
		return null;
	}

	return { submission: verified, destination: verifiedDestination };
}

async function deliverDestination(
	destination: DeliveryDestination,
	submission: Submission,
	ctx: PluginContext,
): Promise<void> {
	if (destination.type === "webhook") {
		if (!ctx.http) throw new Error("HTTP delivery is not configured");
		const response = await ctx.http.fetch(destination.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": destination.id,
				"X-EmDash-Submission-Id": String(destination.body.submissionId),
				"X-EmDash-Receipt-Id": submission.delivery?.receiptId ?? "",
			},
			body: JSON.stringify(destination.body),
		});
		if (!response.ok) {
			throw new Error(`Webhook returned HTTP ${response.status}`);
		}
		return;
	}

	if (!ctx.email) throw new Error("Email delivery is not configured");
	await ctx.email.send({
		to: destination.to,
		subject: destination.subject,
		text: destination.text,
	});
}

async function finishDestination(
	submissionId: string,
	destinationId: string,
	claimToken: string,
	error: unknown | null,
	ctx: PluginContext,
	now: Date,
): Promise<void> {
	const collection = submissions(ctx);
	const current = await collection.get(submissionId);
	const destination = current ? findDestination(current, destinationId) : undefined;
	if (!current?.delivery || !destination || destination.claimToken !== claimToken) return;

	const timestamp = now.toISOString();
	const terminal = error !== null && destination.attempts >= MAX_ATTEMPTS;
	const finished: DeliveryDestination =
		error === null
			? {
					...destination,
					status: "delivered",
					updatedAt: timestamp,
					nextAttemptAt: null,
					claimToken: null,
					deliveredAt: timestamp,
					lastError: null,
				}
			: {
					...destination,
					status: terminal ? "terminal" : "retrying",
					updatedAt: timestamp,
					nextAttemptAt: terminal
						? null
						: new Date(now.getTime() + nextBackoff(destination.attempts)).toISOString(),
					claimToken: null,
					terminalAt: terminal ? timestamp : null,
					lastError: boundedError(error),
				};

	await collection.put(
		submissionId,
		withDeliverySummary({
			...current,
			delivery: {
				...current.delivery,
				destinations: current.delivery.destinations.map((item) =>
					item.id === destinationId ? finished : item,
				),
			},
		}),
	);
}

async function processSubmission(
	submissionId: string,
	submission: Submission,
	ctx: PluginContext,
	now: Date,
): Promise<void> {
	if (submission.delivery?.version !== DELIVERY_VERSION) return;

	for (const destination of submission.delivery.destinations) {
		const claim = await claimDestination(submissionId, destination.id, ctx, now);
		if (!claim) continue;

		let error: unknown | null = null;
		try {
			await deliverDestination(claim.destination, claim.submission, ctx);
		} catch (cause) {
			error = cause;
			ctx.log.error("Forms outbox delivery failed", {
				submissionId,
				receiptId: claim.submission.delivery?.receiptId,
				destinationId: destination.id,
				error: boundedError(cause),
			});
		}

		await finishDestination(
			submissionId,
			destination.id,
			claim.destination.claimToken!,
			error,
			ctx,
			now,
		);
	}
}

let deliveryRun: Promise<void> = Promise.resolve();

async function runDelivery(ctx: PluginContext, options: DeliveryProcessorOptions): Promise<void> {
	const now = options.now ?? new Date();
	const batch = await submissions(ctx).query({
		where: { deliveryNextAttemptAt: { lte: now.toISOString() } },
		orderBy: { deliveryNextAttemptAt: "asc" },
		limit: DELIVERY_BATCH_SIZE,
	});

	for (const item of batch.items) {
		await processSubmission(item.id, item.data, ctx, now);
	}
}

export function handleDelivery(
	ctx: PluginContext,
	options: DeliveryProcessorOptions = {},
): Promise<void> {
	const now = options.now ?? new Date();
	const run = deliveryRun.then(async () => {
		try {
			await runDelivery(ctx, { now });
			const completedAt = options.now ?? new Date();
			await recordHeartbeat(ctx, "success", completedAt.toISOString(), null);
			return undefined;
		} catch (error) {
			const completedAt = options.now ?? new Date();
			try {
				await recordHeartbeat(ctx, "failure", completedAt.toISOString(), error);
			} catch (heartbeatError) {
				ctx.log.error("Forms outbox heartbeat failed", {
					error: boundedError(heartbeatError),
				});
			}
			throw error;
		}
	});
	deliveryRun = run.catch(() => {});
	return run;
}
