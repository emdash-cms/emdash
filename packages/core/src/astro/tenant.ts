/**
 * EmDash Tenant Resolution
 *
 * Resolves the tenant identifier for a request when EmDash is deployed as a
 * shared instance serving multiple tenants (rows scoped by `tenant_id`
 * rather than one database per tenant). Resolution order, first match wins:
 *
 *   1. `X-Tenant-ID` request header — set by a trusted edge/gateway that has
 *      already authenticated the caller (service-to-service, admin tooling).
 *   2. `tenant_id` query parameter — explicit override, mainly for local
 *      development and internal tooling; avoid relying on it for public
 *      traffic since it's trivially spoofable by a visitor.
 *   3. `emdash-tenant-id` cookie — set once a session has resolved its
 *      tenant, so subsequent requests in the same browser stay pinned.
 *   4. Request subdomain — the common case for public traffic
 *      (`acme.example.com` -> tenant `acme`). `www` and bare apex domains
 *      fall through to the default tenant.
 *   5. `DEFAULT_TENANT_ID` — single-tenant deployments never set any of the
 *      above, so they transparently keep working.
 */

import { DEFAULT_TENANT_ID } from "../request-context.js";

const TENANT_HEADER = "x-tenant-id";
const TENANT_QUERY_PARAM = "tenant_id";
const TENANT_COOKIE = "emdash-tenant-id";

/** Hostnames that never carry a tenant subdomain. */
const NON_TENANT_SUBDOMAINS = new Set(["www", "app", "admin"]);

export interface TenantResolutionInput {
	headers: Headers;
	url: URL;
	cookies: { get(name: string): { value: string } | undefined };
}

/**
 * Extract a subdomain-based tenant slug, if the hostname looks like
 * `<tenant>.<rest>` with at least two labels after the tenant part (so
 * `example.com` and `localhost` don't get misread as a tenant subdomain).
 */
function subdomainTenant(hostname: string): string | undefined {
	const labels = hostname.split(".");
	if (labels.length < 3) return undefined;
	const candidate = labels[0];
	if (!candidate || NON_TENANT_SUBDOMAINS.has(candidate)) return undefined;
	return candidate;
}

/**
 * Resolve the tenant identifier for a request. Never throws — falls back to
 * `DEFAULT_TENANT_ID` when no signal is present, so single-tenant
 * deployments are unaffected.
 */
export function extractTenantId({ headers, url, cookies }: TenantResolutionInput): string {
	const headerValue = headers.get(TENANT_HEADER);
	if (headerValue) return headerValue;

	const queryValue = url.searchParams.get(TENANT_QUERY_PARAM);
	if (queryValue) return queryValue;

	const cookieValue = cookies.get(TENANT_COOKIE)?.value;
	if (cookieValue) return cookieValue;

	const subdomain = subdomainTenant(url.hostname);
	if (subdomain) return subdomain;

	return DEFAULT_TENANT_ID;
}
