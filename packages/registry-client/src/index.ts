/**
 * @emdash-cms/registry-client
 *
 * Atproto-aware client for the EmDash plugin registry. Public surfaces:
 *
 *   - **Credentials** (`./credentials`): persisting the publisher's atproto
 *     session between CLI invocations. Three implementations: filesystem,
 *     env-vars (CI), in-memory (tests).
 *   - **Publishing** (`./publishing`): repo operations against the publisher's
 *     own PDS using a session built by `@atcute/oauth-node-client`. Used by
 *     the CLI's `emdash-plugin publish` flow.
 *   - **Discovery** (`./discovery`): read-only XRPC client over an aggregator.
 *     No authentication. Used by both the CLI (`emdash-plugin search` /
 *     `emdash-plugin info`) and the EmDash admin UI's install flow.
 *   - **Listing policy** (`./listing-policy`): required listing enforcement,
 *     status mapping, and stable cache identity.
 *   - **Withdrawal** (`./withdrawal`): fail-closed evaluation of hydrated
 *     release-withdrawal labels.
 *   - **Environment compatibility** (`./env`): parsing and evaluation of
 *     release requirements against an EmDash host.
 *
 * Each subpath can be imported independently, so discovery consumers do not
 * load publishing or OAuth dependencies.
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

export {
	type ApprovedListing,
	type ListingStatusResult,
	type RegistryLabelerPolicy,
	type UnavailableListing,
	registryLabelerPolicy,
	registryLabelerPolicyKey,
} from "./listing-policy.js";

export {
	type RegistryReleaseWithdrawalOptions,
	type RegistryReleaseWithdrawalResult,
	evaluateRegistryReleaseWithdrawal,
} from "./withdrawal.js";

export {
	type DirectPdsClientOptions,
	type DirectPdsDidDocumentResolver,
	type DirectPdsProfileRecord,
	type DirectPdsReadErrorCode,
	type DirectPdsReleaseRecord,
	DirectPdsClient,
	DirectPdsReadError,
} from "./direct-pds/index.js";

export {
	type CursorPage,
	type DelegationResource,
	type MutationOptions as ReleaseServiceMutationOptions,
	type MutationResult,
	type OperatorClientOptions,
	type OperatorPublisherResource,
	type PublisherControlResource,
	type PublisherResource,
	type PutWorkloadPolicyInput,
	type ReleaseIntentResource,
	type ReleaseIntentResult,
	type ReleaseIntentState,
	type ReleaseServiceApiErrorCode,
	type ReleaseServiceClientErrorCode,
	type ReleaseServiceClientOptions,
	type RequestOptions as ReleaseServiceRequestOptions,
	type ServiceControlState,
	type SubmitReleaseIntentInput,
	type SubmitReleaseIntentResult,
	type WaitForIntentOptions,
	type WorkloadPolicyResource,
	ReleaseServiceClient,
	ReleaseServiceError,
	ReleaseServiceOperatorClient,
	TERMINAL_RELEASE_INTENT_STATES,
	createReleaseIdempotencyKey,
} from "./release-service/index.js";

export {
	type EnvMismatch,
	type HostEnv,
	type SkippedEnvConstraint,
	checkEnvCompatibility,
	findSkippedEnvConstraints,
	hostEnvFromVersions,
	isValidVersionRange,
	parseRequires,
	satisfiesRange,
} from "./env/index.js";
