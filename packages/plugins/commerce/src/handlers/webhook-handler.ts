/**
 * Shared payment-webhook orchestration entrypoint for gateway providers.
 *
 * The commerce kernel stays the only place that writes orders, payment attempts,
 * webhook receipts, and inventory. Providers/third-party modules should adapt to
 * this contract instead of writing storage directly.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { buildRateLimitActorKey } from "../lib/rate-limit-identity.js";
import { requirePost } from "../lib/require-post.js";
import {
	finalizePaymentFromWebhook,
	type FinalizeWebhookInput,
	type FinalizeWebhookResult,
	type FinalizePaymentPorts,
} from "../orchestration/finalize-payment.js";
import { throwCommerceApiError } from "../route-errors.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";

type Col<T> = StorageCollection<T>;

function asCollection<T>(raw: unknown): Col<T> {
	return raw as Col<T>;
}

export type WebhookProviderInput = Omit<FinalizeWebhookInput, "providerId" | "correlationId">;

export interface CommerceWebhookAdapter<TInput> {
	/**
	 * Canonical provider id for this adapter (`stripe`, `paypal`, etc.).
	 * It is the value written to payment attempts and receipt rows for this route.
	 */
	providerId: string;
	/** Verifies provider signature / replay claims. Should throw via `throwCommerceApiError`. */
	verifyRequest(ctx: RouteContext<TInput>): Promise<void>;
	/** Build finalize payload from raw route input (without providerId/correlationId). */
	buildFinalizeInput(ctx: RouteContext<TInput>): WebhookProviderInput;
	/** Correlation id used for logs and decision traces. */
	buildCorrelationId(ctx: RouteContext<TInput>): string;
	/**
	 * Rate-limit key suffix for this provider.
	 * Keep this provider-scoped (`ip:<hash>`, `provider:<id>` etc.).
	 */
	buildRateLimitSuffix(ctx: RouteContext<TInput>): string;
}

export type WebhookFinalizeResponse =
	| { ok: true; replay: true; reason: string }
	| { ok: true; replay: false; orderId: string };

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

function toWebhookResult(result: FinalizeWebhookResult): WebhookFinalizeResponse {
	if (result.kind === "replay") {
		return { ok: true, replay: true, reason: result.reason };
	}
	if (result.kind === "completed") {
		return { ok: true, replay: false, orderId: result.orderId };
	}
	// api_error
	throwCommerceApiError(result.error);
}

export async function handlePaymentWebhook<TInput>(
	ctx: RouteContext<TInput>,
	adapter: CommerceWebhookAdapter<TInput>,
): Promise<WebhookFinalizeResponse> {
	requirePost(ctx);

	const contentLength = ctx.request.headers.get("content-length");
	const n = contentLength !== null && contentLength !== "" ? Number(contentLength) : Number.NaN;
	if (Number.isFinite(n)) {
		if (n > COMMERCE_LIMITS.maxWebhookBodyBytes) {
			throwCommerceApiError({
				code: "PAYLOAD_TOO_LARGE",
				message: "Webhook body is too large",
			});
		}
	} else {
		const bodyText = await ctx.request.clone().text();
		const bodyBytes = new TextEncoder().encode(bodyText).byteLength;
		if (bodyBytes > COMMERCE_LIMITS.maxWebhookBodyBytes) {
			throwCommerceApiError({
				code: "PAYLOAD_TOO_LARGE",
				message: "Webhook body is too large",
			});
		}
	}

	await adapter.verifyRequest(ctx);

	const nowMs = Date.now();
	const ipHash = await buildRateLimitActorKey(ctx, `webhook:${adapter.buildRateLimitSuffix(ctx)}`);
	const allowed = await consumeKvRateLimit({
		kv: ctx.kv,
		keySuffix: `webhook:${adapter.buildRateLimitSuffix(ctx)}:${ipHash}`,
		limit: COMMERCE_LIMITS.defaultWebhookPerIpPerWindow,
		windowMs: COMMERCE_LIMITS.defaultRateWindowMs,
		nowMs,
	});
	if (!allowed) {
		throwCommerceApiError({
			code: "RATE_LIMITED",
			message: "Too many webhook deliveries from this network path",
		});
	}

	const input = adapter.buildFinalizeInput(ctx);
	const finalInput: FinalizeWebhookInput = {
		...input,
		providerId: adapter.providerId,
		correlationId: adapter.buildCorrelationId(ctx),
	};
	const result = await finalizePaymentFromWebhook(buildFinalizePorts(ctx), finalInput);
	return toWebhookResult(result);
}
