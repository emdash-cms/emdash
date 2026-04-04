/**
 * Stripe webhook entrypoint with in-route signature verification.
 * The route still accepts the typed JSON body for deterministic plugin tests.
 */

import type { RouteContext } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import { hmacSha256HexAsync, constantTimeEqualHexAsync } from "../lib/crypto-adapter.js";
import { throwCommerceApiError } from "../route-errors.js";
import type { StripeWebhookEventInput, StripeWebhookInput } from "../schemas.js";
import { handlePaymentWebhook, type CommerceWebhookAdapter } from "./webhook-handler.js";

const MAX_WEBHOOK_BODY_BYTES = COMMERCE_LIMITS.maxWebhookBodyBytes;
const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_SIGNATURE_TOLERANCE_MIN_SECONDS = 30;
const STRIPE_SIGNATURE_TOLERANCE_MAX_SECONDS = 7_200;
const STRIPE_PROVIDER_ID = "stripe";
const STRIPE_METADATA_ORDER_ID_KEYS = ["orderId", "emdashOrderId", "emdash_order_id"] as const;
const STRIPE_METADATA_FINALIZE_TOKEN_KEYS = [
	"finalizeToken",
	"emdashFinalizeToken",
	"emdash_finalize_token",
] as const;

type ParsedStripeSignature = {
	timestamp: number;
	signatures: string[];
};

type StripeMetadataInput = {
	orderId: string;
	finalizeToken: string;
	externalEventId: string;
};

function normalizeHeaderKeyValue(raw: string): [string, string] | null {
	const [key, value] = raw.split("=").map((entry) => entry.trim());
	if (!key || !value) return null;
	return [key, value];
}

function clampStripeTolerance(raw: unknown): number {
	const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
	if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return STRIPE_SIGNATURE_TOLERANCE_SECONDS;
	if (parsed < STRIPE_SIGNATURE_TOLERANCE_MIN_SECONDS) return STRIPE_SIGNATURE_TOLERANCE_MIN_SECONDS;
	if (parsed > STRIPE_SIGNATURE_TOLERANCE_MAX_SECONDS) return STRIPE_SIGNATURE_TOLERANCE_MAX_SECONDS;
	return parsed;
}

function selectFromMetadata(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = input?.[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function extractStripeFinalizeMetadata(event: unknown): StripeMetadataInput | null {
	if (!event || typeof event !== "object") return null;
	const payload = event as StripeWebhookEventInput;
	if (!("id" in payload) || typeof payload.id !== "string") return null;
	if (
		!payload.data ||
		typeof payload.data !== "object" ||
		!payload.data.object ||
		typeof payload.data.object !== "object"
	) {
		return null;
	}

	const metadata = payload.data.object.metadata;
	if (!metadata || typeof metadata !== "object") return null;
	const objectMetadata = metadata as Record<string, unknown>;

	const orderId = selectFromMetadata(objectMetadata, STRIPE_METADATA_ORDER_ID_KEYS);
	const finalizeToken = selectFromMetadata(objectMetadata, STRIPE_METADATA_FINALIZE_TOKEN_KEYS);
	if (!orderId || !finalizeToken) return null;

	return {
		orderId,
		finalizeToken,
		externalEventId: payload.id,
	};
}

function parseStripeSignatureHeader(raw: string | null): ParsedStripeSignature | null {
	if (!raw) return null;
	const sigParts = raw.split(",");
	let timestamp: number | null = null;
	const signatures: string[] = [];

	for (const part of sigParts) {
		const pair = normalizeHeaderKeyValue(part);
		if (!pair) continue;
		const [key, value] = pair;
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

async function isWebhookSignatureValid(
	secret: string,
	rawBody: string,
	rawSignature: string | null,
	toleranceSeconds: number,
): Promise<boolean> {
	const parsed = parseStripeSignatureHeader(rawSignature);
	if (!parsed) return false;
	const now = Date.now() / 1000;
	if (Math.abs(now - parsed.timestamp) > toleranceSeconds) return false;

	const expected = await hashWithSecret(secret, parsed.timestamp, rawBody);
	for (const sig of parsed.signatures) {
		if (await constantTimeEqualHexAsync(sig, expected)) return true;
	}
	return false;
}

async function ensureValidStripeWebhookSignature(
	ctx: RouteContext<StripeWebhookInput>,
): Promise<void> {
	const secret = await ctx.kv.get("settings:stripeWebhookSecret");
	if (typeof secret !== "string" || secret.length === 0) {
		throwCommerceApiError({
			code: "PROVIDER_UNAVAILABLE",
			message: "Missing Stripe webhook signature secret",
		});
	}

	const rawBody = await ctx.request.clone().text();
	const tolerance = await resolveWebhookSignatureToleranceSeconds(ctx);
	if (!isWebhookBodyWithinSizeLimit(rawBody)) {
		throwCommerceApiError({
			code: "PAYLOAD_TOO_LARGE",
			message: "Webhook body is too large",
		});
	}
	const rawSig = ctx.request.headers.get(STRIPE_SIGNATURE_HEADER);
	if (!(await isWebhookSignatureValid(secret, rawBody, rawSig, tolerance))) {
		throwCommerceApiError({
			code: "WEBHOOK_SIGNATURE_INVALID",
			message: "Invalid Stripe webhook signature",
		});
	}
}

async function resolveWebhookSignatureToleranceSeconds(ctx: RouteContext<StripeWebhookInput>): Promise<number> {
	const setting = await ctx.kv.get<unknown>("settings:stripeWebhookToleranceSeconds");
	if (typeof setting === "number") {
		return clampStripeTolerance(setting);
	}
	return clampStripeTolerance(typeof setting === "string" ? setting : undefined);
}

const stripeWebhookAdapter: CommerceWebhookAdapter<StripeWebhookInput> = {
	providerId: STRIPE_PROVIDER_ID,
	verifyRequest: ensureValidStripeWebhookSignature,
	buildFinalizeInput(ctx) {
		if ("orderId" in ctx.input) {
			return {
				orderId: ctx.input.orderId,
				externalEventId: ctx.input.externalEventId,
				providerId: ctx.input.providerId ?? STRIPE_PROVIDER_ID,
				finalizeToken: ctx.input.finalizeToken,
			};
		}

		const parsedMetadata = extractStripeFinalizeMetadata(ctx.input);
		if (!parsedMetadata) {
			throwCommerceApiError({
				code: "ORDER_STATE_CONFLICT",
				message: "Missing required emDash webhook metadata",
			});
		}

		return {
			orderId: parsedMetadata.orderId,
			externalEventId: parsedMetadata.externalEventId,
			providerId: STRIPE_PROVIDER_ID,
			finalizeToken: parsedMetadata.finalizeToken,
		};
	},
	buildCorrelationId(ctx) {
		if ("correlationId" in ctx.input && ctx.input.correlationId) {
			return ctx.input.correlationId;
		}
		const parsedMetadata = extractStripeFinalizeMetadata(ctx.input);
		if (parsedMetadata) {
			return parsedMetadata.externalEventId;
		}
		return "unknown-event";
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
	resolveWebhookSignatureToleranceSeconds,
	isWebhookSignatureValid,
	clampStripeTolerance,
	extractStripeFinalizeMetadata,
	parseStripeSignatureHeader,
};
