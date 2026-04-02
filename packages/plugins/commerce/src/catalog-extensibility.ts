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
 * Reserved hook names for future event fan-out (loyalty, analytics, MCP).
 * Not registered by the commerce kernel until those slices exist.
 */
export const COMMERCE_EXTENSION_HOOKS = {
	/** After a read-only recommendation response is produced (future). */
	recommendationsResolved: "commerce:recommendations-resolved",
} as const;
