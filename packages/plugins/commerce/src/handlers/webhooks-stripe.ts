/**
 * Stripe webhook entrypoint (signature verification lands with the real Stripe adapter).
 * Today accepts a structured JSON body so finalize + replay tests can run without Stripe.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { finalizePaymentFromWebhook } from "../orchestration/finalize-payment.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { StripeWebhookInput } from "../schemas.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

export async function stripeWebhookHandler(ctx: RouteContext<StripeWebhookInput>) {
	const correlationId = ctx.input.correlationId ?? ctx.input.externalEventId;

	const result = await finalizePaymentFromWebhook(
		{
			orders: asCollection<StoredOrder>(ctx.storage.orders),
			webhookReceipts: asCollection<StoredWebhookReceipt>(ctx.storage.webhookReceipts),
			paymentAttempts: asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts),
			inventoryLedger: asCollection<StoredInventoryLedgerEntry>(ctx.storage.inventoryLedger),
			inventoryStock: asCollection<StoredInventoryStock>(ctx.storage.inventoryStock),
		},
		{
			orderId: ctx.input.orderId,
			providerId: ctx.input.providerId,
			externalEventId: ctx.input.externalEventId,
			correlationId,
		},
	);

	if (result.kind === "replay") {
		return { ok: true as const, replay: true as const, reason: result.reason };
	}
	if (result.kind === "api_error") {
		throwCommerceApiError(result.error);
	}
	return { ok: true as const, orderId: result.orderId };
}
