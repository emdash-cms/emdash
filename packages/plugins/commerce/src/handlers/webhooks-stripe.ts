/**
 * Stripe webhook entrypoint (signature verification lands with the real Stripe adapter).
 * Today accepts a structured JSON body so finalize + replay tests can run without Stripe.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { requirePost } from "../lib/require-post.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { sha256Hex } from "../hash.js";
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

const MAX_WEBHOOK_BODY_BYTES = 65_536;

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

export async function stripeWebhookHandler(ctx: RouteContext<StripeWebhookInput>) {
	requirePost(ctx);

	// Future: verify `Stripe-Signature` with `request.text()` + `ctx.kv.get("settings:stripeWebhookSecret")`.

	const cl = ctx.request.headers.get("content-length");
	if (cl !== null && cl !== "") {
		const n = Number(cl);
		if (Number.isFinite(n) && n > MAX_WEBHOOK_BODY_BYTES) {
			throwCommerceApiError({
				code: "PAYLOAD_TOO_LARGE",
				message: "Webhook body is too large",
			});
		}
	}

	const nowMs = Date.now();
	const ip = ctx.requestMeta.ip ?? "unknown";
	const ipHash = sha256Hex(ip).slice(0, 32);
	const allowed = await consumeKvRateLimit({
		kv: ctx.kv,
		keySuffix: `webhook:stripe:ip:${ipHash}`,
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

	const correlationId = ctx.input.correlationId ?? ctx.input.externalEventId;

	const result = await finalizePaymentFromWebhook(
		{
			orders: asCollection<StoredOrder>(ctx.storage.orders),
			webhookReceipts: asCollection<StoredWebhookReceipt>(ctx.storage.webhookReceipts),
			paymentAttempts: asCollection<StoredPaymentAttempt>(ctx.storage.paymentAttempts),
			inventoryLedger: asCollection<StoredInventoryLedgerEntry>(ctx.storage.inventoryLedger),
			inventoryStock: asCollection<StoredInventoryStock>(ctx.storage.inventoryStock),
			log: ctx.log,
		},
		{
			orderId: ctx.input.orderId,
			providerId: ctx.input.providerId,
			externalEventId: ctx.input.externalEventId,
			correlationId,
			finalizeToken: ctx.input.finalizeToken,
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
