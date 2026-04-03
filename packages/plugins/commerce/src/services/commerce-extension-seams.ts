/**
 * Stable service seams for extension and MCP consumers.
 *
 * These helpers expose read-only or adapter-based entry points so third-party
 * packages can integrate without replacing kernel-owned mutation logic.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { handlePaymentWebhook, type CommerceWebhookAdapter, type WebhookFinalizeResponse } from "../handlers/webhook-handler.js";
import { createRecommendationsHandler, type RecommendationsHandlerOptions, type RecommendationsResponse } from "../handlers/recommendations.js";
import {
	queryFinalizationStatus,
	type FinalizationStatus,
	type FinalizePaymentPorts,
} from "../orchestration/finalize-payment.js";
import type { RecommendationsInput } from "../schemas.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";

type Collection<T> = StorageCollection<T>;

function asCollection<T>(raw: unknown): Collection<T> {
	return raw as Collection<T>;
}

function buildFinalizePorts(ctx: RouteContext<unknown>): FinalizePaymentPorts {
	return {
		orders: asCollection<StoredOrder>(ctx.storage.orders),
		webhookReceipts: asCollection<StoredWebhookReceipt>(ctx.storage.webhookReceipts),
		paymentAttempts: asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts),
		inventoryLedger: asCollection<StoredInventoryLedgerEntry>(ctx.storage.inventoryLedger),
		inventoryStock: asCollection<StoredInventoryStock>(ctx.storage.inventoryStock),
		log: ctx.log,
	};
}

export type {
	FinalizationStatus,
	CommerceWebhookAdapter,
	RecommendationsResponse,
};

export const COMMERCE_MCP_ACTORS = {
	system: "system",
	merchant: "merchant",
	agent: "agent",
	customer: "customer",
} as const;

export type CommerceMcpActor = keyof typeof COMMERCE_MCP_ACTORS;

export type CommerceMcpOperationContext = {
	actor: CommerceMcpActor;
	actorId?: string;
	requestId?: string;
	traceId?: string;
};

export function createRecommendationsRoute(
	options: RecommendationsHandlerOptions = {},
): (ctx: RouteContext<RecommendationsInput>) => Promise<RecommendationsResponse> {
	return createRecommendationsHandler(options);
}

export function createPaymentWebhookRoute<TInput>(
	adapter: CommerceWebhookAdapter<TInput>,
): (ctx: RouteContext<TInput>) => Promise<WebhookFinalizeResponse> {
	return (ctx: RouteContext<TInput>) => handlePaymentWebhook(ctx, adapter);
}

export type FinalizationStatusInput = {
	orderId: string;
	providerId: string;
	externalEventId: string;
};

export async function queryFinalizationState(
	ctx: RouteContext<unknown>,
	input: FinalizationStatusInput,
): Promise<FinalizationStatus> {
	return queryFinalizationStatus(buildFinalizePorts(ctx), input.orderId, input.providerId, input.externalEventId);
}
