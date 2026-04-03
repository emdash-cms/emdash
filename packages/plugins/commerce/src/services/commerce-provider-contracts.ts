import type { RouteContext } from "emdash";

export type CommerceProviderType = "payment" | "shipping" | "tax" | "fulfillment";

const DEFAULT_PAYMENT_PROVIDER_ID = "stripe";

/** Standard checkout/provider default used by the money path contracts. */
export const PAYMENT_DEFAULTS = {
	defaultPaymentProviderId: DEFAULT_PAYMENT_PROVIDER_ID,
} as const;

/**
 * Resolve a provider identifier from user input and preserve deterministic defaults.
 * Empty/whitespace values are treated as "unset" and map to the checkout default.
 */
export function resolvePaymentProviderId(value: string | undefined): string {
	const normalized = value?.trim() ?? "";
	return normalized.length > 0 ? normalized : PAYMENT_DEFAULTS.defaultPaymentProviderId;
}

export interface CommerceProviderDescriptor {
	providerId: string;
	providerType: CommerceProviderType;
	isActive: boolean;
	displayName?: string;
}

export interface CommerceWebhookInput {
	orderId: string;
	externalEventId: string;
	finalizeToken: string;
}

/**
 * Provider-specific webhook adapter contract for third-party payment integrations.
 * The adapter is responsible for request authenticity checks and extracting
 * domain inputs for finalize orchestration.
 */
export interface CommerceWebhookAdapter<TInput> {
	/** Canonical provider id used in receipts/attempts and payment diagnostics. */
	providerId: string;
	/** Verify request authenticity and freshness before any checkout mutation is performed. */
	verifyRequest(ctx: RouteContext<TInput>): Promise<void>;
	/** Convert a raw provider request into finalized orchestration input fields. */
	buildFinalizeInput(ctx: RouteContext<TInput>): CommerceWebhookInput;
	/** Stable request correlation for logs and replay diagnostics. */
	buildCorrelationId(ctx: RouteContext<TInput>): string;
	/** Provider-scoped suffix for webhook rate-limit keys. */
	buildRateLimitSuffix(ctx: RouteContext<TInput>): string;
}

export type CommerceWebhookFinalizeResponse =
	| { ok: true; replay: true; reason: string }
	| { ok: true; replay: false; orderId: string };

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
