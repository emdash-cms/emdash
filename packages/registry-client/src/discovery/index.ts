/**
 * Discovery client.
 *
 * Reads from an EmDash plugin registry aggregator. The aggregator implements
 * the `com.emdashcms.experimental.aggregator.*` XRPC methods over plain HTTP,
 * so this client works in any runtime that has `fetch` -- Node, Workers, the
 * browser, the EmDash admin UI.
 *
 * No authentication is required for discovery: the aggregator is a public
 * read-only index. Hard-enforcement labels (`!takedown`, `security:yanked`) are
 * applied server-side based on the request's `atproto-accept-labelers` header,
 * which the aggregator client may set per-request.
 */

import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type {
	AggregatorGetLatestRelease,
	AggregatorGetPackage,
	AggregatorListReleases,
	AggregatorResolvePackage,
	AggregatorSearchPackages,
} from "@emdash-cms/registry-lexicons";

/**
 * Options for constructing a `DiscoveryClient`.
 */
export interface DiscoveryClientOptions {
	/**
	 * Aggregator base URL. Must be the origin where the aggregator's XRPC
	 * endpoints are mounted (i.e. `${aggregatorUrl}/xrpc/<nsid>` resolves to a
	 * valid endpoint).
	 *
	 * During the experimental phase this is `experimental-registry.emdashcms.com`
	 * (exact host TBD); see the implementation plan for the cutover schedule.
	 */
	aggregatorUrl: string;

	/**
	 * Optional comma-separated list of labeller DIDs to forward as the
	 * `atproto-accept-labelers` request header. The aggregator uses this to
	 * decide which labellers' hard-enforcement labels (`!takedown`, etc.) to
	 * apply when filtering results.
	 *
	 * Format follows the atproto convention: `did:plc:abc;redact, did:plc:def`
	 * where the optional `;redact` flag asks for label content to be redacted.
	 *
	 * Defaults to no header, which means the aggregator applies whatever its
	 * own default policy is (typically: filter on its own publisher-verification
	 * labeller plus any operator-configured trusted labellers).
	 */
	acceptLabelers?: string;

	/**
	 * Optional custom `fetch` implementation. Defaults to globalThis.fetch.
	 * Useful for testing (mock fetch) or for environments where you need to
	 * route through a specific transport.
	 */
	fetch?: typeof fetch;
}

/**
 * Read-only client over an EmDash plugin registry aggregator.
 *
 * Wraps `@atcute/client` with the aggregator URL pre-bound and the
 * `atproto-accept-labelers` header threaded through every request. Method
 * names mirror the aggregator's XRPC method names (without the NSID prefix).
 *
 * @example
 * ```ts
 * const discovery = new DiscoveryClient({
 *   aggregatorUrl: "https://experimental-registry.emdashcms.com",
 * });
 * const result = await discovery.searchPackages({ q: "gallery", limit: 10 });
 * for (const pkg of result.packages) {
 *   console.log(pkg.uri, pkg.profile.name);
 * }
 * ```
 */
export class DiscoveryClient {
	readonly aggregatorUrl: string;
	readonly acceptLabelers: string | undefined;
	readonly #client: Client;

	constructor(options: DiscoveryClientOptions) {
		this.aggregatorUrl = options.aggregatorUrl;
		this.acceptLabelers = options.acceptLabelers;

		const baseHandler = simpleFetchHandler({
			service: options.aggregatorUrl,
			fetch: options.fetch ?? globalThis.fetch,
		});

		// Wrap the handler so every outgoing request carries the
		// `atproto-accept-labelers` header when configured. We always
		// *overwrite* any value the caller might have supplied: this is the
		// aggregator's policy, not a per-request setting, and letting
		// downstream code substitute its own labellers would defeat the
		// point of the wrapper.
		const acceptLabelers = this.acceptLabelers;
		const handler: typeof baseHandler = acceptLabelers
			? async (pathname, init) => {
					const headers = new Headers(init.headers);
					headers.set("atproto-accept-labelers", acceptLabelers);
					return baseHandler(pathname, { ...init, headers });
				}
			: baseHandler;

		this.#client = new Client({ handler });
	}

	/**
	 * Search packages by free-text query and optional filters. Hard-takedown
	 * results are filtered server-side; remaining results have label state
	 * hydrated.
	 *
	 * Throws `ClientResponseError` (from `@atcute/client`) on a non-2xx
	 * response. The error carries `.error`, `.description`, `.status`, and
	 * `.headers`.
	 */
	async searchPackages(
		params: AggregatorSearchPackages.$params,
	): Promise<AggregatorSearchPackages.$output> {
		return ok(this.#client.get("com.emdashcms.experimental.aggregator.searchPackages", { params }));
	}

	/**
	 * Fetch a single package's full hydrated view by its AT URI.
	 */
	async getPackage(params: AggregatorGetPackage.$params): Promise<AggregatorGetPackage.$output> {
		return ok(this.#client.get("com.emdashcms.experimental.aggregator.getPackage", { params }));
	}

	/**
	 * Resolve a package by publisher handle + slug (or DID + slug). Cheaper
	 * than `getPackage` when you only have human-readable identifiers.
	 */
	async resolvePackage(
		params: AggregatorResolvePackage.$params,
	): Promise<AggregatorResolvePackage.$output> {
		return ok(this.#client.get("com.emdashcms.experimental.aggregator.resolvePackage", { params }));
	}

	/**
	 * List releases for a package, paginated and ordered by descending
	 * semver version (newest version first), not by time. Yanked releases
	 * are interleaved by version. Use `getLatestRelease` for the
	 * convention "give me the highest non-yanked version".
	 */
	async listReleases(
		params: AggregatorListReleases.$params,
	): Promise<AggregatorListReleases.$output> {
		return ok(this.#client.get("com.emdashcms.experimental.aggregator.listReleases", { params }));
	}

	/**
	 * Fetch the package's latest non-yanked release. Convenience wrapper around
	 * `listReleases` that the aggregator can implement more efficiently than
	 * client-side max-version selection (the version constraint engine lives
	 * on the aggregator).
	 */
	async getLatestRelease(
		params: AggregatorGetLatestRelease.$params,
	): Promise<AggregatorGetLatestRelease.$output> {
		return ok(
			this.#client.get("com.emdashcms.experimental.aggregator.getLatestRelease", { params }),
		);
	}
}
