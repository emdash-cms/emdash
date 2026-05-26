/**
 * Strict Content-Security-Policy for /_emdash routes (admin + API).
 *
 * Applied via middleware header rather than Astro's built-in CSP because
 * Astro's auto-hashing defeats 'unsafe-inline' (CSP3 ignores 'unsafe-inline'
 * when hashes are present), which would break user-facing pages.
 *
 * img-src allows any HTTPS origin because the admin renders user content that
 * may reference external images (migrations, external hosting, embeds).
 * Plugin security does not rely on img-src -- plugins run in V8 isolates with
 * no DOM access. connect-src stays at 'self' unless the experimental registry
 * is configured, in which case the configured aggregator origin is allowed.
 */
import type { RegistryConfigInput } from "../../registry/types.js";

function getRegistryAggregatorOrigin(
	registry: RegistryConfigInput | undefined,
): string | undefined {
	const aggregatorUrl = typeof registry === "string" ? registry : registry?.aggregatorUrl;
	if (!aggregatorUrl) return undefined;

	try {
		const url = new URL(aggregatorUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function buildEmDashCsp(registry?: RegistryConfigInput): string {
	const connectSrc = ["connect-src 'self'"];
	const registryAggregatorOrigin = getRegistryAggregatorOrigin(registry);
	if (registryAggregatorOrigin) connectSrc.push(registryAggregatorOrigin);

	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",
		connectSrc.join(" "),
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' https: data: blob:",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}
