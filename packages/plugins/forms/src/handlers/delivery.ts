import type { RouteContext, StorageCollection } from "emdash";
import { PluginRouteError } from "emdash";

import {
	DELIVERY_HEARTBEAT_KEY,
	DELIVERY_HEARTBEAT_STALE_MS,
	summarizeDelivery,
} from "../outbox.js";
import type { ReceiptStatusInput } from "../schemas.js";
import type { DeliveryDestination, DeliveryHeartbeat, Submission } from "../types.js";

function submissions(ctx: RouteContext): StorageCollection<Submission> {
	return ctx.storage.submissions as StorageCollection<Submission>;
}

function destinationStatus(destination: DeliveryDestination) {
	return {
		id: destination.id,
		type: destination.type,
		status: destination.status,
		attempts: destination.attempts,
		timestamps: {
			createdAt: destination.createdAt,
			updatedAt: destination.updatedAt,
			nextAttemptAt: destination.nextAttemptAt,
			claimedAt: destination.claimedAt,
			attemptedAt: destination.attemptedAt,
			deliveredAt: destination.deliveredAt,
			terminalAt: destination.terminalAt,
		},
	};
}

export async function receiptStatusHandler(ctx: RouteContext<ReceiptStatusInput>) {
	const result = await submissions(ctx).query({
		where: { receiptId: ctx.input.receiptId },
		limit: 1,
	});
	const submission = result.items[0]?.data;
	if (!submission?.delivery || submission.receiptId !== ctx.input.receiptId) {
		throw PluginRouteError.notFound("Receipt not found");
	}

	const destinations = submission.delivery.destinations.map(destinationStatus);
	return {
		receiptId: submission.receiptId,
		status: submission.deliveryStatus ?? summarizeDelivery(submission.delivery).status,
		attempts: destinations.reduce((total, destination) => total + destination.attempts, 0),
		timestamps: {
			createdAt: submission.createdAt,
			updatedAt:
				destinations
					.map((destination) => destination.timestamps.updatedAt)
					.toSorted()
					.at(-1) ?? submission.createdAt,
			nextAttemptAt: submission.deliveryNextAttemptAt ?? null,
			deliveredAt:
				destinations.length > 0 &&
				destinations.every((destination) => destination.timestamps.deliveredAt !== null)
					? destinations
							.map((destination) => destination.timestamps.deliveredAt!)
							.toSorted()
							.at(-1)!
					: null,
			terminalAt:
				destinations
					.map((destination) => destination.timestamps.terminalAt)
					.filter((value): value is string => value !== null)
					.toSorted()
					.at(-1) ?? null,
		},
		destinations,
	};
}

function validHeartbeat(value: DeliveryHeartbeat | null): value is DeliveryHeartbeat {
	return (
		value?.version === 1 &&
		(value.status === "success" || value.status === "failure") &&
		typeof value.completedAt === "string" &&
		(value.lastSuccessAt === null || typeof value.lastSuccessAt === "string")
	);
}

export async function deliveryHealthHandler(ctx: RouteContext, now = new Date()) {
	const [heartbeatValue, dueCount, terminalCount, oldestDue] = await Promise.all([
		ctx.kv.get<DeliveryHeartbeat>(DELIVERY_HEARTBEAT_KEY),
		submissions(ctx).count({
			deliveryNextAttemptAt: { lte: now.toISOString() },
		}),
		submissions(ctx).count({ deliveryStatus: "terminal" }),
		submissions(ctx).query({
			where: { deliveryNextAttemptAt: { lte: now.toISOString() } },
			orderBy: { deliveryNextAttemptAt: "asc" },
			limit: 1,
		}),
	]);

	const heartbeat = validHeartbeat(heartbeatValue) ? heartbeatValue : null;
	const completedAtMs = heartbeat ? Date.parse(heartbeat.completedAt) : NaN;
	const freshness =
		!heartbeat || !Number.isFinite(completedAtMs)
			? "missing"
			: now.getTime() - completedAtMs > DELIVERY_HEARTBEAT_STALE_MS
				? "stale"
				: "fresh";

	return {
		heartbeatStatus: freshness,
		dueCount,
		terminalCount,
		oldestDueAt: oldestDue.items[0]?.data.deliveryNextAttemptAt ?? null,
		lastRunAt: heartbeat?.completedAt ?? null,
		lastSuccessAt: heartbeat?.lastSuccessAt ?? null,
		lastError: heartbeat?.status === "failure" ? "Delivery processor failed" : null,
	};
}
