/**
 * Stripe webhook entrypoint with in-route signature verification.
 * The route still accepts the typed JSON body for deterministic plugin tests.
 */

import type { RouteContext, StorageCollection } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { requirePost } from "../lib/require-post.js";
import { consumeKvRateLimit } from "../lib/rate-limit-kv.js";
import { sha256Hex } from "../hash.js";
import {
	hmacSha256HexAsync,
	constantTimeEqualHexAsync,
} from "../lib/crypto-adapter.js";
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
const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

function parseStripeSignatureHeader(raw: string | null): ParsedStripeSignature | null {
	if (!raw) return null;
	const sigParts = raw.split(",");
	let timestamp: number | null = null;
	const signatures: string[] = [];

	for (const part of sigParts) {
		const [key, value] = part.split("=").map((entry) => entry.trim());
		if (!key || !value) continue;
		if (key === "t") {
			const parsed = Number.parseInt(value, 10);
			if (Number.isNaN(parsed)) return null;
			timestamp = parsed;
			continue;
		}
		if (key === "v1") {
			signatures.push(value);
		}
	}
	if (timestamp === null || signatures.length === 0) return null;
	return { timestamp, signatures };
}

async function hashWithSecret(secret: string, timestamp: number, rawBody: string): Promise<string> {
	return hmacSha256HexAsync(secret, `${timestamp}.${rawBody}`);
}

function isWebhookBodyWithinSizeLimit(rawBody: string): boolean {
	return new TextEncoder().encode(rawBody).byteLength <= MAX_WEBHOOK_BODY_BYTES;
}

async function isWebhookSignatureValid(secret: string, rawBody: string, rawSignature: string | null): Promise<boolean> {
	const parsed = parseStripeSignatureHeader(rawSignature);
	if (!parsed) return false;
	const now = Date.now() / 1000;
	if (Math.abs(now - parsed.timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

	const expected = await hashWithSecret(secret, parsed.timestamp, rawBody);
	for (const sig of parsed.signatures) {
		if (await constantTimeEqualHexAsync(sig, expected)) return true;
	}
	return false;
}

async function ensureValidStripeWebhookSignature(ctx: RouteContext<StripeWebhookInput>): Promise<void> {
	const secret = await ctx.kv.get("settings:stripeWebhookSecret");
	if (typeof secret !== "string" || secret.length === 0) {
		throwCommerceApiError({
			code: "PROVIDER_UNAVAILABLE",
			message: "Missing Stripe webhook signature secret",
		});
	}

	const rawBody = await ctx.request.clone().text();
	if (!isWebhookBodyWithinSizeLimit(rawBody)) {
		throwCommerceApiError({
			code: "PAYLOAD_TOO_LARGE",
			message: "Webhook body is too large",
		});
	}
	const rawSig = ctx.request.headers.get(STRIPE_SIGNATURE_HEADER);
	if (!(await isWebhookSignatureValid(secret, rawBody, rawSig))) {
		throwCommerceApiError({
			code: "WEBHOOK_SIGNATURE_INVALID",
			message: "Invalid Stripe webhook signature",
		});
	}
}

type ParsedStripeSignature = {
	timestamp: number;
	signatures: string[];
};

function asCollection<T>(raw: unknown): StorageCollection<T> {
	return raw as StorageCollection<T>;
}

export async function stripeWebhookHandler(ctx: RouteContext<StripeWebhookInput>) {
	requirePost(ctx);
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
	await ensureValidStripeWebhookSignature(ctx);

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

export {
	hashWithSecret,
	isWebhookBodyWithinSizeLimit,
	isWebhookSignatureValid,
	parseStripeSignatureHeader,
};
