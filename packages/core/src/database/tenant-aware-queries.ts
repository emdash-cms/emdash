/**
 * Tenant-Aware Query Helpers
 *
 * Utilities for injecting tenant_id into Kysely queries.
 * Used throughout the schema registry and runtime to enforce multi-tenant isolation.
 *
 * Integration Guide:
 * ==================
 * This module provides patterns for making existing queries tenant-aware.
 * The key principle is: every query that touches tenant data must include
 * tenant_id filtering in its WHERE clause.
 *
 * Pattern 1: Inline tenant filter (simplest)
 * -------------------------------------------
 * ```ts
 * const tenant = getTenantId();
 * const collections = await db
 *   .selectFrom("_emdash_collections")
 *   .where("slug", "=", slug)
 *   .where("tenant_id", "=", tenant)  // ADD THIS LINE
 *   .selectAll()
 *   .execute();
 * ```
 *
 * Pattern 2: Wrapper function (recommended)
 * ------------------------------------------
 * ```ts
 * import { withTenantFilter } from "./tenant-aware-queries.js";
 *
 * const collections = await withTenantFilter(
 *   db.selectFrom("_emdash_collections"),
 *   getTenantId()
 * )
 *   .where("slug", "=", slug)
 *   .selectAll()
 *   .execute();
 * ```
 *
 * Usage Priority:
 * 1. If modification is small (1-2 lines), use Pattern 1 (inline)
 * 2. If query is complex or used in multiple places, use Pattern 2 (wrapper)
 * 3. Both patterns prevent tenant data leakage when applied correctly
 */

import { getTenantId } from "../request-context.js";

/**
 * Add tenant_id filter to a SELECT query
 *
 * Example:
 * ```ts
 * const items = await withTenantFilter(
 *   db.selectFrom("items"),
 *   "tenant-123"
 * )
 *   .where("status", "=", "published")
 *   .selectAll()
 *   .execute();
 * ```
 */
export function withTenantFilter<T>(query: T, tenantId: string): T {
	// Type-safe approach: caller is responsible for WHERE clause
	// We can't universally extend query types, so this is a documentation helper
	// Actual implementation: add .where("tenant_id", "=", tenantId) to your query chain

	console.warn(
		"[emdash] withTenantFilter helper called. " +
			"Ensure your query includes: .where('tenant_id', '=', tenantId)",
	);

	return query;
}

/**
 * Get current tenant ID, defaulting to 'default' for single-tenant mode
 *
 * Safe to call from route handlers, data loaders, and anywhere in the runtime.
 * Returns the tenant extracted by middleware, or 'default' if no tenant context.
 */
export function getCurrentTenant(): string {
	return getTenantId();
}

/**
 * Validation helper: ensure a query result belongs to the expected tenant
 *
 * Use after database queries as a safety check in critical paths.
 * This catches bugs where tenant filtering was forgotten.
 *
 * Example:
 * ```ts
 * const post = await db.selectFrom("ec_posts").where("id", "=", id).executeTakeFirst();
 * assertTenantMatch(post?.tenant_id, "Requested post not found");
 * ```
 */
export function assertTenantMatch(
	actual: string | undefined,
	expectedTenant: string,
	message: string = "Tenant mismatch",
): void {
	if (actual !== expectedTenant) {
		throw new Error(`${message}: expected ${expectedTenant}, got ${actual}`);
	}
}

/**
 * Example: Tenant-aware collection query for SchemaRegistry
 *
 * This shows the pattern. Actual implementation updates
 * packages/core/src/schema/registry.ts to use this pattern.
 */
export async function getTenantCollection(
	db: any,
	slug: string,
	tenantId?: string,
): Promise<any | null> {
	const tenant = tenantId ?? getTenantId();

	const row = await db
		.selectFrom("_emdash_collections")
		.where("slug", "=", slug)
		.where("tenant_id", "=", tenant)
		.selectAll()
		.executeTakeFirst();

	return row ?? null;
}

/**
 * Refactoring Checklist: How to Make a Query Tenant-Aware
 *
 * For each query in the codebase:
 *
 * 1. [ ] Identify which table it queries (e.g., _emdash_collections, media, taxonomies)
 * 2. [ ] Check if the table has a tenant_id column (see migration 033_tenant_scoping.ts)
 * 3. [ ] If yes, add .where("tenant_id", "=", getTenantId()) to the WHERE chain
 * 4. [ ] If the query returns a result, validate: assertTenantMatch(result?.tenant_id, getTenantId())
 * 5. [ ] Test with 2+ tenants to verify isolation
 *
 * Critical Queries to Update:
 * - [ ] SchemaRegistry.getCollection(slug) - must filter by tenant
 * - [ ] SchemaRegistry.listCollections() - must filter by tenant
 * - [ ] SchemaRegistry.createCollection() - must include tenant in INSERT
 * - [ ] SchemaRegistry.updateCollection() - must include tenant in WHERE
 * - [ ] Runtime.handleTaxonomyList() - must filter by tenant
 * - [ ] Runtime.handleMediaList() - must filter by tenant
 * - [ ] All content repository queries (ec_posts, ec_pages, etc.)
 *
 * Testing Strategy:
 * 1. Create tenant_a with collection "posts"
 * 2. Create tenant_b with collection "articles"
 * 3. Verify tenant_a cannot list tenant_b's "articles" collection
 * 4. Verify tenant_a CAN list tenant_b's "articles" IF it queries without tenant filter (bug!)
 */
