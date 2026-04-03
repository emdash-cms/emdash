/**
 * Stripe webhook entrypoint with in-route signature verification.
 * The route still accepts the typed JSON body for deterministic plugin tests.
 */

import type { RouteContext } from "emdash";

import {
	hmacSha256HexAsync,
	constantTimeEqualHexAsync,
} from "../lib/crypto-adapter.js";
import { throwCommerceApiError } from "../route-errors.js";
import {
	handlePaymentWebhook,
	type CommerceWebhookAdapter,
} from "./webhook-handler.js";
import type { StripeWebhookInput } from "../schemas.js";

const MAX_WEBHOOK_BODY_BYTES = 65_536;
const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_PROVIDER_ID = "stripe";

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

const stripeWebhookAdapter: CommerceWebhookAdapter<StripeWebhookInput> = {
	providerId: STRIPE_PROVIDER_ID,
	verifyRequest: ensureValidStripeWebhookSignature,
	buildFinalizeInput(ctx) {
		return {
			orderId: ctx.input.orderId,
			externalEventId: ctx.input.externalEventId,
			finalizeToken: ctx.input.finalizeToken,
		};
	},
	buildCorrelationId(ctx) {
		return ctx.input.correlationId ?? ctx.input.externalEventId;
	},
	buildRateLimitSuffix() {
		return "stripe:ip";
	},
};

export async function stripeWebhookHandler(ctx: RouteContext<StripeWebhookInput>) {
	return handlePaymentWebhook(ctx, stripeWebhookAdapter);
}

export {
	hashWithSecret,
	isWebhookBodyWithinSizeLimit,
	isWebhookSignatureValid,
	parseStripeSignatureHeader,
};
