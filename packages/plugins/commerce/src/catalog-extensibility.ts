/**
 * Contracts for catalog / content integration — vector search, LLM context, MCP.
 *
 * Commerce storage holds **IDs and numeric snapshots** on line items (`productId`,
 * `variantId`, `unitPriceMinor`, `quantity`). Rich text, `shortDescription`, and
 * embedding payloads belong on **catalog documents** (EmDash content or a future
 * core vector index), not duplicated on orders.
 *
 * @see ../AI-EXTENSIBILITY.md
 */

/** Optional fields a catalog product document may expose for search and agents. */
export interface CommerceCatalogProductSearchFields {
	/** Plain text for embeddings, snippets, and LLM grounding (alongside PT body for humans). */
	shortDescription?: string;
	/** Stable id of the content node or blob used when generating embeddings. */
	searchDocumentId?: string;
}

/**
 * Read-only recommendation contract used by storefront features and read-only MCP
 * tooling. The commerce kernel remains authoritative for checkout/finalization
 * and inventory writes.
 *
 * Third-party recommender implementations must be side-effect free with respect
 * to commerce documents.
 */
export type CommerceRecommendationInput = {
	productId?: string;
	variantId?: string;
	cartId?: string;
	limit?: number;
};

export type CommerceRecommendationResult = {
	productIds: readonly string[];
	providerId?: string;
	reason?: string;
};

export interface CommerceRecommendationResolver {
	(ctx: CommerceRecommendationInput): Promise<CommerceRecommendationResult | null>;
}

/**
 * Closed-kernel service boundary for recommendation providers.
 *
 * Providers are intentionally read-only and should only surface candidate product
 * identifiers. They must not mutate carts, orders, attempts, or receipts.
 */
export interface CommerceRecommendationContract extends CommerceRecommendationResolver {
	readonly providerId: string;
	readonly readOnly: true;
}

/**
 * Reserved hook names for future event fan-out (loyalty, analytics, MCP).
 * Not registered by the commerce kernel until those slices exist.
 */
export const COMMERCE_EXTENSION_HOOKS = {
	/** After a read-only recommendation response is produced. */
	recommendationsResolved: "commerce:recommendations-resolved",
} as const;

/**
 * Reserved hook names for future event fan-out (loyalty, analytics, MCP).
 * Not registered by the commerce kernel until those slices exist.
 */
export const COMMERCE_RECOMMENDATION_HOOKS = {
	...COMMERCE_EXTENSION_HOOKS,
} as const;

/**
 * Kernel invariants exposed to third-party integrators.
 *
 * The values are not meant as runtime policy controls; they are explicit API
 * guarantees for integrators and MCP tool authors.
 */
export const COMMERCE_KERNEL_RULES = {
	/** Checkout, webhook verification, and finalize are closed to extension bypass. */
	no_kernel_bypass: "commerce:kernel-no-bypass",
	/**
	 * Third-party recommendation/catalog integrations are post-derivation only and
	 * cannot mutate commerce state.
	 */
	read_only_extensions: "commerce:read-only-extensions",
	/**
	 * All external calls for order read and payment state must pass through stable
	 * exported services (`queryFinalizationStatus`, `finalizePaymentFromWebhook`,
	 * `queryFinalizationState`).
	 */
	service_entry_points_only: "commerce:service-entry-points-only",
} as const;
