import { createAggregatorPreviousReleaseLookup } from "../aggregator-reconciliation.js";
import { createWorkersAiCodeReviewAdapter } from "../ai/code-review.js";
import type { WorkersAiBinding } from "../ai/workers-ai.js";
import type { GuardedMediaTransport, MediaHostnameResolver } from "../assessment/media.js";
import {
	createBlobCachePackageBundleReader,
	type CodeAssessmentDependencies,
} from "./assessment.js";
import { createR2CodeRulesetSource, type CodeRulesetBucket } from "./ruleset-source.js";

const RULESET_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export class CodeAssessmentConfigurationError extends Error {
	override readonly name = "CodeAssessmentConfigurationError";
}

/**
 * Code assessment stays off until `LABELER_CODE_RULESET_KEY` names the ruleset
 * object. Once the key is set, a missing binding is a configuration error
 * rather than a silent fallback to metadata-only assessment.
 */
export function createProductionCodeAssessment(
	env: object,
	options: {
		ai: WorkersAiBinding;
		resolver: MediaHostnameResolver;
		transport: GuardedMediaTransport;
	},
): CodeAssessmentDependencies | undefined {
	const key: unknown = Reflect.get(env, "LABELER_CODE_RULESET_KEY");
	if (key === undefined || key === "") return undefined;
	if (typeof key !== "string" || !RULESET_KEY_RE.test(key)) {
		throw new CodeAssessmentConfigurationError("LABELER_CODE_RULESET_KEY is invalid");
	}
	const bucket: unknown = Reflect.get(env, "CODE_RULESET");
	if (!isRulesetBucket(bucket)) {
		throw new CodeAssessmentConfigurationError(
			"LABELER_CODE_RULESET_KEY is set but the CODE_RULESET bucket binding is missing",
		);
	}
	const aggregator: unknown = Reflect.get(env, "AGGREGATOR_RECONCILIATION");
	const token: unknown = Reflect.get(env, "RECONCILIATION_TOKEN");
	if (!isFetcher(aggregator) || typeof token !== "string") {
		throw new CodeAssessmentConfigurationError(
			"code assessment requires the aggregator reconciliation binding and token",
		);
	}
	return {
		rulesets: createR2CodeRulesetSource(bucket, key),
		bundleReader: createBlobCachePackageBundleReader({
			resolver: options.resolver,
			transport: options.transport,
		}),
		previousReleases: createAggregatorPreviousReleaseLookup(aggregator, token),
		createReviewAdapter: (config) => createWorkersAiCodeReviewAdapter(options.ai, config),
	};
}

function isRulesetBucket(value: unknown): value is CodeRulesetBucket {
	return (
		typeof value === "object" && value !== null && "get" in value && typeof value.get === "function"
	);
}

function isFetcher(value: unknown): value is Fetcher {
	return (
		typeof value === "object" &&
		value !== null &&
		"fetch" in value &&
		typeof value.fetch === "function"
	);
}
