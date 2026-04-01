/**
 * x402 Payment Enforcer
 *
 * Creates the x402 enforcement interface. Uses the @x402/core SDK
 * to handle the payment protocol negotiation.
 */

import {
	decodePaymentSignatureHeader,
	encodePaymentRequiredHeader,
	encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer, type ResourceConfig } from "@x402/core/server";

import type { EnforceOptions, EnforceResult, X402Config, X402Enforcer } from "./types.js";

const PAYMENT_SIGNATURE_HEADER = "payment-signature";
const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
const DEFAULT_SCHEME = "exact";
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_BOT_SCORE_THRESHOLD = 30;

/**
 * Cached resource server instance.
 * Initialized once per process, reused across requests.
 */
let _resourceServer: x402ResourceServer | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Get or create the x402ResourceServer singleton.
 */
async function getResourceServer(config: X402Config): Promise<x402ResourceServer> {
	if (!_resourceServer) {
		const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
		const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
		const server = new x402ResourceServer(facilitator);

		// Register EVM scheme (default)
		if (config.evm !== false) {
			try {
				const evmMod = await import("@x402/evm/exact/server");
				const evmScheme = new evmMod.ExactEvmScheme();
				server.register("eip155:*" as `${string}:${string}`, evmScheme);
			} catch {
				// @x402/evm not installed -- skip EVM support
			}
		}

		// Register SVM scheme (opt-in)
		if (config.svm) {
			try {
				const svmMod = await import("@x402/svm/exact/server");
				const svmScheme = new svmMod.ExactSvmScheme();
				server.register("solana:*" as `${string}:${string}`, svmScheme);
			} catch {
				// @x402/svm not installed -- skip Solana support
			}
		}

		_resourceServer = server;
		_initPromise = server.initialize();
	}

	if (_initPromise) {
		await _initPromise;
		_initPromise = null;
	}

	return _resourceServer;
}

/**
 * Check if a request is from a bot using Cloudflare Bot Management.
 * Returns true if the request is likely from a bot, false otherwise.
 * When bot management data is unavailable (local dev, non-CF deployment),
 * returns false (treat as human).
 */
function isBot(request: Request, threshold: number): boolean {
	// Cloudflare Workers expose cf properties on the request
	const cf: unknown = Reflect.get(request, "cf");
	if (cf == null || typeof cf !== "object") return false;
	const bm: unknown = Reflect.get(cf, "botManagement");
	if (bm == null || typeof bm !== "object") return false;
	const score: unknown = Reflect.get(bm, "score");
	if (typeof score !== "number") return false;
	return score < threshold;
}

/**
 * Create an X402Enforcer for the given configuration.
 * Called once by the middleware, reused across requests.
 */
export function createEnforcer(config: X402Config): X402Enforcer {
	const botScoreThreshold = config.botScoreThreshold ?? DEFAULT_BOT_SCORE_THRESHOLD;

	return {
		async enforce(request: Request, options?: EnforceOptions): Promise<Response | EnforceResult> {
			// In botOnly mode, skip enforcement for humans
			if (config.botOnly && !isBot(request, botScoreThreshold)) {
				return { paid: false, skipped: true, responseHeaders: {} };
			}

			const server = await getResourceServer(config);

			const price = options?.price ?? config.defaultPrice;
			if (price == null) {
				throw new Error(
					"x402: No price specified. Pass a price in enforce() options or set defaultPrice in the config.",
				);
			}

			const payTo = options?.payTo ?? config.payTo;
			const network = options?.network ?? config.network;
			const scheme = options?.scheme ?? config.scheme ?? DEFAULT_SCHEME;
			const maxTimeoutSeconds = config.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

			const resourceConfig: ResourceConfig = {
				scheme,
				payTo,
				price: normalizePrice(price),
				network,
				maxTimeoutSeconds,
			};

			const url = new URL(request.url);
			const resourceInfo = {
				url: url.pathname,
				description: options?.description,
				mimeType: options?.mimeType,
			};

			// Check for payment signature header
			const paymentHeader =
				request.headers.get(PAYMENT_SIGNATURE_HEADER) || request.headers.get("PAYMENT-SIGNATURE");

			if (!paymentHeader) {
				return make402(server, resourceConfig, resourceInfo, "Payment required");
			}

			// Payment present -- decode and verify
			const paymentPayload = decodePaymentSignatureHeader(paymentHeader);
			const requirements = await server.buildPaymentRequirements(resourceConfig);
			const matchingReqs = server.findMatchingRequirements(requirements, paymentPayload);

			if (!matchingReqs) {
				return make402(
					server,
					resourceConfig,
					resourceInfo,
					"Payment does not match accepted requirements",
				);
			}

			// Verify with facilitator
			const verifyResult = await server.verifyPayment(paymentPayload, matchingReqs);

			if (!verifyResult.isValid) {
				return make402(
					server,
					resourceConfig,
					resourceInfo,
					verifyResult.invalidReason ?? "Payment verification failed",
				);
			}

			// Settle
			const settleResult = await server.settlePayment(paymentPayload, matchingReqs);

			const responseHeaders: Record<string, string> = {};
			if (settleResult) {
				responseHeaders[PAYMENT_RESPONSE_HEADER] = encodePaymentResponseHeader(settleResult);
			}

			return {
				paid: true,
				skipped: false,
				payer: verifyResult.payer,
				settlement: settleResult,
				responseHeaders,
			};
		},

		applyHeaders(result: EnforceResult, response: { headers: Headers }): void {
			for (const [key, value] of Object.entries(result.responseHeaders)) {
				response.headers.set(key, value);
			}
		},

		hasPayment(request: Request): boolean {
			return !!(
				request.headers.get(PAYMENT_SIGNATURE_HEADER) || request.headers.get("PAYMENT-SIGNATURE")
			);
		},
	};
}

/** Build and return a 402 Response */
async function make402(
	server: x402ResourceServer,
	resourceConfig: ResourceConfig,
	resourceInfo: { url: string; description?: string; mimeType?: string },
	error: string,
): Promise<Response> {
	const requirements = await server.buildPaymentRequirements(resourceConfig);
	const paymentRequired = await server.createPaymentRequiredResponse(
		requirements,
		resourceInfo,
		error,
	);

	return new Response(JSON.stringify(paymentRequired), {
		status: 402,
		headers: {
			"Content-Type": "application/json",
			[PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(paymentRequired),
		},
	});
}

/**
 * Normalize a user-friendly price into the format expected by x402 SDK.
 */
function normalizePrice(
	price: string | number | { amount: string; asset: string; extra?: Record<string, unknown> },
): string | number | { amount: string; asset: string; extra?: Record<string, unknown> } {
	if (typeof price === "string" && price.startsWith("$")) {
		return price.slice(1);
	}
	return price;
}
