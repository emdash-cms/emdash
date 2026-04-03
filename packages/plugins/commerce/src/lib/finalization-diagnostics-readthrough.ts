/**
 * Read-through cache + in-flight coalescing for `queryFinalizationState`.
 *
 * EmDash serverless defaults: many warm isolates each have their own in-memory
 * singleflight map; KV cache + fixed-window rate limits align reads across
 * instances and protect storage from dashboard/MCP polling bursts.
 */

import type { RouteContext } from "emdash";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import type { FinalizationStatus } from "../orchestration/finalize-payment.js";
import { throwCommerceApiError } from "../route-errors.js";
import { sha256HexAsync } from "./crypto-adapter.js";
import { consumeKvRateLimit } from "./rate-limit-kv.js";

const CACHE_KEY_PREFIX = "state:finalize_diag:v1:";

type CachedEnvelopeV1 = {
	v: 1;
	expiresAtMs: number;
	status: FinalizationStatus;
};

const inFlightByStableKey = new Map<string, Promise<FinalizationStatus>>();

function isFinalizationStatusLike(value: unknown): value is FinalizationStatus {
	if (!value || typeof value !== "object") return false;
	const o = value as Record<string, unknown>;
	return (
		typeof o.receiptStatus === "string" &&
		typeof o.isInventoryApplied === "boolean" &&
		typeof o.isOrderPaid === "boolean" &&
		typeof o.isPaymentAttemptSucceeded === "boolean" &&
		typeof o.isReceiptProcessed === "boolean" &&
		typeof o.resumeState === "string"
	);
}

function parseCachedEnvelope(raw: unknown, nowMs: number): FinalizationStatus | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (o.v !== 1) return null;
	if (typeof o.expiresAtMs !== "number" || o.expiresAtMs <= nowMs) return null;
	if (!isFinalizationStatusLike(o.status)) return null;
	return o.status;
}

export type FinalizationDiagnosticsInput = {
	orderId: string;
	providerId: string;
	externalEventId: string;
};

/**
 * Rate-limits diagnostics reads per client IP, then returns a cached result when
 * fresh, otherwise runs `fetcher` with per-isolate in-flight dedupe.
 */
export async function readFinalizationStatusWithGuards(
	ctx: RouteContext<unknown>,
	input: FinalizationDiagnosticsInput,
	fetcher: () => Promise<FinalizationStatus>,
): Promise<FinalizationStatus> {
	const nowMs = Date.now();
	const ip = ctx.requestMeta.ip ?? "unknown";
	const ipHash = (await sha256HexAsync(ip)).slice(0, 32);

	const allowed = await consumeKvRateLimit({
		kv: ctx.kv,
		keySuffix: `finalize_diag:ip:${ipHash}`,
		limit: COMMERCE_LIMITS.defaultFinalizationDiagnosticsPerIpPerWindow,
		windowMs: COMMERCE_LIMITS.defaultRateWindowMs,
		nowMs,
	});
	if (!allowed) {
		throwCommerceApiError({
			code: "RATE_LIMITED",
			message: "Too many finalization diagnostics requests; try again shortly",
		});
	}

	const stableKey = await sha256HexAsync(
		`${input.orderId}\0${input.providerId}\0${input.externalEventId}`,
	);
	const kvCacheKey = `${CACHE_KEY_PREFIX}${stableKey.slice(0, 48)}`;

	const cached = parseCachedEnvelope(await ctx.kv.get<unknown>(kvCacheKey), nowMs);
	if (cached) {
		return structuredClone(cached);
	}

	let pending = inFlightByStableKey.get(stableKey);
	if (!pending) {
		pending = (async () => {
			try {
				const status = await fetcher();
				const envelope: CachedEnvelopeV1 = {
					v: 1,
					expiresAtMs: Date.now() + COMMERCE_LIMITS.finalizationDiagnosticsCacheTtlMs,
					status,
				};
				await ctx.kv.set(kvCacheKey, envelope);
				return status;
			} finally {
				inFlightByStableKey.delete(stableKey);
			}
		})();
		inFlightByStableKey.set(stableKey, pending);
	}

	return structuredClone(await pending);
}
