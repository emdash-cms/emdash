/**
 * @emdash-cms/registry-client
 *
 * Atproto-aware client for the EmDash plugin registry. Three layers:
 *
 *   - **Credentials** (`./credentials`): persisting the publisher's atproto
 *     session between CLI invocations. Three implementations: filesystem,
 *     env-vars (CI), in-memory (tests).
 *   - **Publishing** (`./publishing`): repo operations against the publisher's
 *     own PDS using a session built by `@atcute/oauth-node-client`. Used by
 *     the CLI's `emdash-registry publish` flow.
 *   - **Discovery** (`./discovery`): read-only XRPC client over an aggregator.
 *     No authentication. Used by both the CLI (`emdash-registry search` /
 *     `emdash-registry info`) and the EmDash admin UI's install flow.
 *
 * The two halves are deliberately decoupled so consumers that only need
 * discovery (most notably the admin UI) don't have to pull in the publishing
 * surface or its OAuth dependencies.
 *
 * EXPERIMENTAL: this client targets the experimental aggregator and
 * `com.emdashcms.experimental.*` lexicons. NSIDs and shapes will change while
 * RFC 0001 is in flight; pin to an exact version.
 */

// Re-exported from `@atcute/client` so consumers don't need a separate dep on
// it just to catch errors from this client. Both publishing and discovery
// throw `ClientResponseError` on non-2xx responses; it carries `.error`,
// `.description`, `.status`, and `.headers`.
export { ClientResponseError } from "@atcute/client";

export {
	type CredentialStore,
	type Did,
	type FileCredentialStoreOptions,
	type Handle,
	type PublisherSession,
	EnvCredentialStore,
	FileCredentialStore,
	MemoryCredentialStore,
	ReadOnlyCredentialStoreError,
	defaultCredentialStore,
} from "./credentials/index.js";

export { type PublishingClientFromHandlerOptions, PublishingClient } from "./publishing/index.js";

export { type DiscoveryClientOptions, DiscoveryClient } from "./discovery/index.js";
