/**
 * Plugin storage document shapes for commerce (stage-1 vertical slice).
 * Field names use camelCase so they match indexed JSON paths.
 */

import type { OrderPaymentPhase } from "./kernel/finalize-decision.js";

export type { OrderPaymentPhase };

export interface CartLineItem {
	productId: string;
	/** Empty string when the catalog does not use variants. */
	variantId?: string;
	quantity: number;
	/** Inventory version captured when the line was last mutated (optimistic finalize). */
	inventoryVersion: number;
	unitPriceMinor: number;
}

export interface StoredCart {
	currency: string;
	lineItems: CartLineItem[];
	updatedAt: string;
}

export interface OrderLineItem {
	productId: string;
	variantId?: string;
	quantity: number;
	inventoryVersion: number;
	unitPriceMinor: number;
}

export interface StoredOrder {
	cartId: string;
	paymentPhase: OrderPaymentPhase;
	currency: string;
	lineItems: OrderLineItem[];
	totalMinor: number;
	createdAt: string;
	updatedAt: string;
}

export type PaymentAttemptStatus = "pending" | "succeeded" | "failed";

export interface StoredPaymentAttempt {
	orderId: string;
	providerId: string;
	status: PaymentAttemptStatus;
	externalRef?: string;
	createdAt: string;
	updatedAt: string;
}

export type WebhookReceiptStatus = "processed" | "duplicate" | "pending" | "error";

export interface StoredWebhookReceipt {
	providerId: string;
	externalEventId: string;
	orderId: string;
	status: WebhookReceiptStatus;
	correlationId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface StoredIdempotencyKey {
	route: string;
	keyHash: string;
	httpStatus: number;
	responseBody: unknown;
	createdAt: string;
}

/** Append-only movement row; materialized quantity lives in {@link StoredInventoryStock}. */
export interface StoredInventoryLedgerEntry {
	productId: string;
	/** Empty string when the catalog does not use variants. */
	variantId: string;
	delta: number;
	referenceType: string;
	referenceId: string;
	createdAt: string;
}

export interface StoredInventoryStock {
	productId: string;
	variantId: string;
	version: number;
	quantity: number;
	updatedAt: string;
}
