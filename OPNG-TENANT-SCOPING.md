# opng.in Multi-Tenant Integration Roadmap

## Context

emdash is currently a single-tenant CMS. opng.in will use emdash as its rendering engine, but needs multi-tenant support where one emdash instance serves multiple opng.in tenants with strict isolation.

## Architecture Decision: Shared Instance with Query Scoping

**Why this approach?**
- Cost-efficient: Single database, single Workers deployment
- Operational simplicity: One upgrade cycle, unified monitoring
- Data consistency: All tenants' taxonomies/media in same DB with foreign keys

**Implementation strategy**: Add `tenant_id` foreign key to all content tables, implemented via Kysely query builder extensions.

## Phase 1: Tenant Column Schema Changes

### 1.1 New Migration: Add Tenant Columns

**File**: `packages/core/src/database/migrations/033_tenant_scoping.ts`

Tables affected:
- `revisions` - add `tenant_id TEXT NOT NULL DEFAULT 'default'`
- `taxonomies` - add `tenant_id TEXT NOT NULL DEFAULT 'default'` 
- `content_taxonomies` - add `tenant_id TEXT NOT NULL DEFAULT 'default'`
- `media` - add `tenant_id TEXT NOT NULL DEFAULT 'default'`
- `audit_logs` - add `tenant_id TEXT NOT NULL DEFAULT 'default'`
- `_emdash_collections` - add `tenant_id TEXT NOT NULL DEFAULT 'default'` (system table)
- `_emdash_fields` - add `tenant_id TEXT NOT NULL DEFAULT 'default'` (system table)

Dynamic content tables (ec_posts, ec_pages, etc.):
- Add `tenant_id` column when table is created via SchemaRegistry
- Default to 'default' for backward compatibility

### 1.2 Query Builder Extensions

**File**: `packages/core/src/database/tenant-query.ts` (new)

Create helper functions to wrap queries with tenant filtering:

```ts
// Helper to inject tenant_id filter into queries
export function withTenant<T>(query: SelectQueryBuilder<any, any, T>, tenantId: string): SelectQueryBuilder<any, any, T> {
  // If table has tenant_id column, add WHERE tenant_id = ?
  return query.where('tenant_id', '=', tenantId);
}

// Helper for InsertQueryBuilder
export function withTenantInsert<T>(query: InsertQueryBuilder<any, any, T>, tenantId: string): InsertQueryBuilder<any, any, T> {
  // Add tenant_id to values
  return query.values({ tenant_id: tenantId, ...values });
}

// Similar for UpdateQueryBuilder, DeleteQueryBuilder
```

### 1.3 Request Context Middleware

**File**: `packages/core/src/request-context.ts` (extend existing)

Add tenant_id to RequestContext:

```ts
export interface RequestContext {
  editMode: boolean;
  db: Kysely<Database>;
  tenantId: string;  // NEW
}

// Expose via getRequestContext() helper
export function getTenantId(): string {
  return getRequestContext().tenantId;
}
```

### 1.4 Astro Middleware Updates

**File**: `packages/core/src/astro/middleware.ts` (modify)

Extract tenant_id before creating runtime:

```ts
// Extract tenant from request (domain/header/subdomain priority)
const tenantId = extractTenantId(context);

// Update doInit to pass tenantId to runtime
// Wrap doInit with tenant context
return runWithContext({ editMode: false, db: sessionDb, tenantId }, async () => {
  // ... rest of middleware
});
```

**Tenant extraction logic**:
```ts
function extractTenantId(context: AstroMiddlewareNext): string {
  // Priority:
  // 1. Header: X-Tenant-ID (for API calls)
  // 2. Subdomain: Extract from host (tenant.example.com)
  // 3. Query param: ?tenant_id=... (for dev/testing)
  // 4. Default: 'default'
  
  const headerTenant = context.request.headers.get('X-Tenant-ID');
  if (headerTenant) return headerTenant;
  
  const host = context.url.hostname;
  const parts = host.split('.');
  if (parts.length > 2) {
    return parts[0]; // First part is tenant subdomain
  }
  
  const queryTenant = context.url.searchParams.get('tenant_id');
  if (queryTenant) return queryTenant;
  
  return 'default';
}
```

## Phase 1 Deliverables

- [ ] Migration: Add tenant_id columns to system tables
- [ ] Query builder: Implement withTenant() helpers
- [ ] RequestContext: Add tenantId field
- [ ] Middleware: Extract tenant_id and wrap context
- [ ] Tests: Verify query filtering per tenant
- [ ] Documentation: Update deployment docs with tenant routing

## Phase 2: Runtime Integration (opng.in integration)

Once Phase 1 is solid:
- Implement tenant provisioning hook in opng.in
- Add tenant pre-seeding (collections, taxonomies, sample content)
- Test: Create 2 tenants, verify strict isolation

## Open Questions

1. **Tenant extraction**: Should we prioritize subdomain routing or header-based routing?
   - Tentative: Header for API, subdomain for web
   
2. **Migration order**: Can we safely add `NOT NULL` columns with DEFAULT? 
   - Answer: Yes, SQLite allows DEFAULT on new columns
   
3. **Dynamic content table creation**: Who creates the ec_* table with tenant_id?
   - Answer: SchemaRegistry.createCollection() needs tenant context
   
4. **Backward compatibility**: What about existing single-tenant instances?
   - Answer: DEFAULT 'default' allows existing data to work unchanged

## References

- emdash middleware: `/workspace/emdash/packages/core/src/astro/middleware.ts`
- SchemaRegistry: `/workspace/emdash/packages/core/src/schema/registry.ts`
- Request context: `/workspace/emdash/packages/core/src/request-context.ts`
