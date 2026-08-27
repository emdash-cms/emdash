import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification/fetch";

import {
	createCloudflareImagesDerivativeTransformer,
	createResizedImageModerationAdapter,
	DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
} from "../ai/image-resize.js";
import {
	createWorkersAiImageAdapter,
	createWorkersAiTextAdapter,
	workersAiBindingFromEnv,
} from "../ai/workers-ai.js";
import { createD1ListingLabelIssuer, type ListingLabelIssuer } from "../labels/issuer.js";
import { readLabelerRuntimeConfig, type LabelerRuntimeConfig } from "../runtime-config.js";
import { createDohHostnameResolver } from "../runtime-network.js";
import { createLabelPublicationTarget } from "../subscriptions/publisher.js";
import { createD1AssessmentLifecycleStore } from "./lifecycle.js";
import { createGuardedMediaAcquirer } from "./media.js";
import { createAtprotoExactRecordVerifier } from "./records.js";
import {
	createCloudflareImagesDecoder,
	createR2MediaContentStore,
	createR2ModerationMediaReader,
	createWorkersSocketPinnedTransport,
} from "./runtime-media.js";
import type { AssessmentWorkflowDependencies } from "./workflow.js";

export async function createProductionAssessmentWorkflowDependencies(
	env: Env,
): Promise<AssessmentWorkflowDependencies> {
	const config = await readLabelerRuntimeConfig(env);
	const resolveHostname = createDohHostnameResolver();
	const guardedFetch = createGuardedIdentityFetch(resolveHostname);
	const didResolver = new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver({ fetch: guardedFetch }),
			web: new AtprotoWebDidDocumentResolver({ fetch: guardedFetch }),
		},
	});
	const ai = workersAiBindingFromEnv(env.AI);
	const { connect } = await import("cloudflare:sockets");
	const issuer = await createProductionListingLabelIssuer(env, config);
	return {
		lifecycle: createD1AssessmentLifecycleStore(env.DB),
		recordVerifier: createAtprotoExactRecordVerifier({
			resolveDid: (did) => didResolver.resolve(did),
			fetch: (resource, init) => globalThis.fetch(resource, init),
			resolveHostname,
		}),
		mediaAcquirer: createGuardedMediaAcquirer({
			resolver: {
				async resolve(hostname, options) {
					if (options.signal.aborted) {
						throw new Error("display media hostname resolution was aborted");
					}
					const addresses = await resolveHostname(hostname);
					if (options.signal.aborted) {
						throw new Error("display media hostname resolution was aborted");
					}
					return addresses;
				},
			},
			transport: createWorkersSocketPinnedTransport(connect),
			store: createR2MediaContentStore(env.MEDIA_QUARANTINE, env.DB),
			decoder: createCloudflareImagesDecoder(env.IMAGES),
		}),
		mediaReader: createR2ModerationMediaReader(env.MEDIA_QUARANTINE),
		textAdapter: createWorkersAiTextAdapter(ai, {
			modelId: config.versions.textModelId,
			promptHash: config.versions.textPromptHash,
		}),
		imageAdapter: createResizedImageModerationAdapter(
			createCloudflareImagesDerivativeTransformer(env.IMAGES),
			createWorkersAiImageAdapter(ai, {
				modelId: config.versions.imageModelId,
				promptHash: config.versions.imagePromptHash,
				thinking: false,
			}),
			DEFAULT_MODERATION_IMAGE_DERIVATIVE_OPTIONS,
		),
		policy: {
			...INITIAL_LISTING_POLICY_FIXTURE,
			policyVersion: config.versions.policyVersion,
			requiredPositiveSources: [config.labelerDid],
			acceptedStateSources: [config.labelerDid],
			redactionSources: [config.labelerDid],
			autoPass: "disabled",
		},
		finalizer: issuer,
	};
}

export async function createProductionListingLabelIssuer(
	env: Env,
	configOverride?: LabelerRuntimeConfig,
): Promise<ListingLabelIssuer> {
	const config = configOverride ?? (await readLabelerRuntimeConfig(env));
	const publicationTarget = createLabelPublicationTarget(env.LABEL_SUBSCRIPTION_DO);
	return createD1ListingLabelIssuer({
		db: env.DB,
		automationPolicyVersions: [config.versions.policyVersion],
		requireObservedOperatorSubjects: true,
		issuerDid: config.labelerDid,
		privateKey: config.privateKey,
		resolveDid: async () => ({
			id: config.labelerDid,
			verificationMethod: [
				{
					id: `${config.labelerDid}#atproto_label`,
					type: "Multikey",
					controller: config.labelerDid,
					publicKeyMultibase: config.publicKeyMultibase,
				},
			],
			service: [
				{
					id: `${config.labelerDid}#atproto_labeler`,
					type: "AtprotoLabeler",
					serviceEndpoint: config.serviceUrl,
				},
			],
		}),
		publicationTarget,
		onPublicationError(error, issued) {
			console.error(
				JSON.stringify({
					message: "assessment label publication notification failed",
					sequence: issued.sequence,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		},
	});
}

function createGuardedIdentityFetch(
	resolveHostname: ReturnType<typeof createDohHostnameResolver>,
): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (request.method !== "GET") {
			throw new TypeError("DID resolution may only issue GET requests");
		}
		const result = await fetchVerifiedResource(request.url, {
			fetch: (resource, requestInit) => globalThis.fetch(resource, requestInit),
			resolveHostname,
			maxBytes: 1024 * 1024,
			headerTimeoutMs: 10_000,
			totalTimeoutMs: 20_000,
			maxRedirects: 3,
		});
		if (!result.success) throw new Error(`DID resolution failed: ${result.error.code}`);
		return new Response(result.value.bytes, {
			status: result.value.status,
			headers: result.value.headers,
		});
	};
}
